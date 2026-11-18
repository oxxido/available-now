// Available now: popular, recently released movies and series that already have torrents,
// matched against Seerr so each one can be requested from the same page.
//
// Pipeline, once per REFRESH_MINUTES:
//   1. Candidates come from Seerr discover (TMDB), most popular first:
//      - movies released in the last MOVIE_MAX_AGE_DAYS with at least MIN_VOTES_MOVIE votes;
//      - series with at least MIN_VOTES_TV votes whose last episode aired in the last MAX_AGE_DAYS
//        (news and talk shows are skipped).
//   2. Each candidate is searched in Prowlarr by title. Release names are parsed, CAM/TS/screeners
//      dropped, and only releases of that exact title (and year, or for series the airing season
//      published in the last MAX_AGE_DAYS) count. The best release needs MIN_SEEDERS.
//   3. Candidates are walked until MAX_ITEMS qualify per kind. Searches are cached in
//      data/state.json for CHECK_HOURS and spaced out, so the indexers see a few hundred
//      searches on the first run and only the expired ones after that.
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const env = (name, fallback) => process.env[name] ?? fallback;
const num = (name, fallback) => Number(env(name, fallback));

const CONFIG = {
  port: num("PORT", 3000),
  prowlarrUrl: env("PROWLARR_URL", "http://prowlarr:9696").replace(/\/$/, ""),
  prowlarrKey: env("PROWLARR_API_KEY", ""),
  seerrUrl: env("SEERR_URL", "http://seerr:5055").replace(/\/$/, ""),
  seerrKey: env("SEERR_API_KEY", ""),
  seerrUser: env("SEERR_USER_ID", ""),
  seerrPublicUrl: env("SEERR_PUBLIC_URL", "").replace(/\/$/, ""),
  refreshMinutes: num("REFRESH_MINUTES", 60),
  maxAgeDays: num("MAX_AGE_DAYS", 30),
  movieMaxAgeDays: num("MOVIE_MAX_AGE_DAYS", 365),
  minSeeders: num("MIN_SEEDERS", 30),
  minVotesMovie: num("MIN_VOTES_MOVIE", 100),
  minVotesTv: num("MIN_VOTES_TV", 100),
  maxItems: num("MAX_ITEMS", 80),
  maxCandidates: num("MAX_CANDIDATES", 1000),
  checkHours: num("CHECK_HOURS", 12),
  qualityMinSeeders: num("QUALITY_MIN_SEEDERS", 5),
  searchDelayMs: num("SEARCH_DELAY_MS", 1000),
  dataDir: env("DATA_DIR", join(ROOT, "data")),
};

const STATE_FILE = join(CONFIG.dataDir, "state.json");
const DAY = 86_400_000;
const HOUR = 3_600_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- state

// checks: "movie:<tmdbId>" / "tv:<tmdbId>:S<n>" -> { checkedAt, releases } (Prowlarr search cache)
// shows:  "<tmdbId>" -> { checkedAt, last } (last aired episode, from Seerr)
let state = { checks: {}, shows: {} };
let view = { updatedAt: null, error: null, movies: [], tv: [] };
let running = false;

async function loadState() {
  try {
    const s = JSON.parse(await readFile(STATE_FILE, "utf8"));
    state = { checks: s.checks ?? {}, shows: s.shows ?? {} };
  } catch {
    /* first run */
  }
}

async function saveState() {
  await mkdir(CONFIG.dataDir, { recursive: true });
  await writeFile(STATE_FILE + ".tmp", JSON.stringify(state));
  await rename(STATE_FILE + ".tmp", STATE_FILE);
}

// ---------------------------------------------------------------- release names

const JUNK = /\b(hd)?cam(rip)?\b|\b(hd)?ts(rip)?\b|\btelesync\b|\btc\b|\btelecine\b|\b(dvd)?scr(eener)?\b|\bhq ?cam\b|\bpre-?dvd\b/i;
const EDITIONS = [
  [/\bextended\b/i, "Extended"],
  [/\bremaster(ed)?\b/i, "Remastered"],
  [/\bdirector'?s? ?cut\b|\bdc\b/i, "Director's Cut"],
  [/\banniversary\b/i, "Anniversary"],
  [/\bimax\b/i, "IMAX"],
  [/\bcriterion\b/i, "Criterion"],
  [/\buncut\b/i, "Uncut"],
  [/\bunrated\b/i, "Unrated"],
];

function qualityOf(name) {
  const res = name.match(/\b(2160p|4k|1080p|720p)\b/i)?.[1]?.toLowerCase().replace("4k", "2160p") ?? "";
  const src = /\bremux\b/i.test(name)
    ? "REMUX"
    : /\b(blu-?ray|bdrip|brrip)\b/i.test(name)
      ? "BluRay"
      : /\bweb-?(dl|rip)?\b/i.test(name)
        ? "WEB"
        : /\bhdtv\b/i.test(name)
          ? "HDTV"
          : "";
  return [res, src].filter(Boolean).join(" ");
}

function clean(title) {
  return title
    .replace(/[._]+/g, " ")
    .replace(/^\s*(?:\[[^\]]*\]|www\s\S+\s(?:com|org|net|to)\b)/i, "")
    .replace(/^[\s\-–:]+/, "")
    .replace(/\s+/g, " ")
    .replace(/[\s\-([]+$/, "")
    .trim();
}

export function parseRelease(raw, kind) {
  const name = raw.replace(/[._]+/g, " ");
  if (JUNK.test(name)) return null;
  const editions = EDITIONS.filter(([re]) => re.test(name)).map(([, label]) => label);
  if (kind === "tv") {
    const m =
      name.match(/^(.+?)\s(?:\(?((?:19|20)\d{2})\)?\s)?S(\d{1,2})(?:E(\d{1,3}))?\b/i) ??
      name.match(/^(.+?)\s(?:\(?((?:19|20)\d{2})\)?\s)?Season\s?(\d{1,2})\b/i);
    if (!m) return null;
    const title = clean(m[1]);
    if (!title) return null;
    return {
      title,
      year: m[2] ? Number(m[2]) : null,
      season: Number(m[3]),
      episode: m[4] ? Number(m[4]) : null,
      quality: qualityOf(name),
      editions,
    };
  }
  // The last year-looking token before the quality tags is the release year: "2001 A Space
  // Odyssey 1968 2160p" must not stop at 2001.
  const m = name.match(/^(.+)\s\(?((?:19|20)\d{2})\)?(?:\s|$)/);
  if (!m) return null;
  const title = clean(m[1]);
  if (!title) return null;
  return { title, year: Number(m[2]), quality: qualityOf(name), editions };
}

const norm = (s) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");

// ---------------------------------------------------------------- upstream APIs

// Seerr rejects queries with reserved characters that encodeURIComponent leaves alone.
const q = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// With a category filter some indexers (The Pirate Bay) search only their own "TV shows" or
// "Movies" section and miss HD releases filed elsewhere, so search unfiltered and keep results
// whose own category is Movies (2xxx) or TV (5xxx).
const CATEGORY = { movie: 2000, tv: 5000 };

async function prowlarrSearch(query, kind) {
  const url = `${CONFIG.prowlarrUrl}/api/v1/search?query=${q(query)}&type=search&limit=100`;
  const res = await fetch(url, { headers: { "X-Api-Key": CONFIG.prowlarrKey }, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Prowlarr ${res.status} ${res.statusText}`);
  const want = CATEGORY[kind];
  return (await res.json()).filter((r) => (r.categories ?? []).some((c) => Math.floor(c.id / 1000) * 1000 === want));
}

async function seerr(path, init = {}) {
  const headers = { "X-Api-Key": CONFIG.seerrKey, "Content-Type": "application/json", ...init.headers };
  if (CONFIG.seerrUser) headers["X-API-User"] = CONFIG.seerrUser;
  const res = await fetch(`${CONFIG.seerrUrl}/api/v1${path}`, { ...init, headers, signal: AbortSignal.timeout(30_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message || `Seerr ${res.status}`), { status: res.status });
  return body;
}

const yearOf = (r) => Number((r.releaseDate || r.firstAirDate || "").slice(0, 4)) || null;
const pad = (n) => String(n).padStart(2, "0");

function pickMedia(r, kind) {
  return {
    mediaType: kind,
    tmdbId: r.id,
    title: r.title ?? r.name,
    year: yearOf(r),
    overview: r.overview ?? "",
    posterPath: r.posterPath ?? null,
    backdropPath: r.backdropPath ?? null,
    voteCount: r.voteCount ?? 0,
    voteAverage: r.voteAverage ?? 0,
    popularity: r.popularity ?? 0,
    status: r.mediaInfo?.status ?? 1,
  };
}

// ---------------------------------------------------------------- candidates and torrents

const SKIP_TV_GENRES = new Set([10763, 10767]); // News, Talk

async function* discover(kind) {
  const since = new Date(Date.now() - CONFIG.movieMaxAgeDays * DAY).toISOString().slice(0, 10);
  const seen = new Set();
  for (let page = 1; seen.size < CONFIG.maxCandidates; page++) {
    const d = await seerr(
      kind === "movie"
        ? `/discover/movies?page=${page}&sortBy=popularity.desc&primaryReleaseDateGte=${since}&voteCountGte=${CONFIG.minVotesMovie}`
        : `/discover/tv?page=${page}&sortBy=popularity.desc&voteCountGte=${CONFIG.minVotesTv}`,
    );
    for (const r of d.results ?? []) {
      if (seen.has(r.id) || (r.genreIds ?? []).some((g) => SKIP_TV_GENRES.has(g))) continue;
      seen.add(r.id);
      yield r;
    }
    if (page >= (d.totalPages ?? 1)) return;
  }
}

// Does a parsed release name belong to this title? NoNaMe-style "Русское / English" names count
// when either side matches.
export function sameTitle(parsedTitle, media) {
  const names = [media.title, media.originalTitle, media.name, media.originalName].filter(Boolean).map(norm);
  return parsedTitle.split(/\s*\/\s*/).some((t) => t && names.includes(norm(t)));
}

// Releases of this movie (title + year ±1), or of this season of this series published since cutoff.
export function relevantReleases(results, kind, media, { season, cutoff } = {}) {
  const year = yearOf(media);
  const out = [];
  for (const r of results) {
    if (r.protocol && r.protocol !== "torrent") continue;
    const p = parseRelease(r.title, kind);
    if (!p || !sameTitle(p.title, media)) continue;
    if (kind === "movie" && year && Math.abs(p.year - year) > 1) continue;
    if (kind === "tv" && (p.season !== season || !(Date.parse(r.publishDate) >= cutoff))) continue;
    out.push({ title: r.title, seeders: r.seeders ?? 0, publishDate: r.publishDate, parsed: p });
  }
  return out.sort((a, b) => b.seeders - a.seeders);
}

// Release names spell "Grey's Anatomy: X & Y" as "Greys.Anatomy.X.and.Y", and indexers match words.
export const searchText = (title) => title.replace(/['’]/g, "").replace(/&/g, "and").replace(/[:!?,]/g, " ").replace(/\s+/g, " ").trim();

// Empty results are often a flaky indexer, so they are retried sooner.
// Quality badges: a resolution is offered when its best release has QUALITY_MIN_SEEDERS.
const RESOLUTIONS = [["2160p", "4K"], ["1080p", "1080p"]];

export function qualitiesOf(releases, minSeeders) {
  return RESOLUTIONS.flatMap(([res, label]) => {
    const best = releases.filter((r) => r.parsed.quality.startsWith(res)).sort((a, b) => b.seeders - a.seeders)[0];
    return best && best.seeders >= minSeeders ? [{ label, seeders: best.seeders, quality: best.parsed.quality, releaseName: best.title }] : [];
  });
}

const fresh = (entry, now) =>
  entry && now - entry.checkedAt < (entry.releases?.length === 0 ? CONFIG.checkHours / 4 : CONFIG.checkHours) * HOUR;

async function cachedSearch(key, now, search) {
  if (fresh(state.checks[key], now)) return state.checks[key].releases;
  const all = await search();
  // The 10 most seeded, plus the best of each resolution so the quality badges survive the cut.
  const releases = [...new Set([...all.slice(0, 10), ...RESOLUTIONS.map(([res]) => all.find((r) => r.parsed.quality.startsWith(res))).filter(Boolean)])];
  state.checks[key] = { checkedAt: now, releases };
  await sleep(CONFIG.searchDelayMs);
  return releases;
}

async function lastAired(r, now) {
  const cached = state.shows[r.id];
  if (fresh(cached, now)) return cached.last;
  const d = await seerr(`/tv/${r.id}`);
  const e = d.lastEpisodeToAir;
  const last = e ? { season: e.seasonNumber, episode: e.episodeNumber, airDate: e.airDate } : null;
  state.shows[r.id] = { checkedAt: now, last };
  return last;
}

async function collect(kind, now, errors) {
  const cutoff = now - CONFIG.maxAgeDays * DAY;
  const items = [];
  let searched = 0;
  for await (const r of discover(kind)) {
    if (items.length >= CONFIG.maxItems) break;
    try {
      let releases, season;
      if (kind === "movie") {
        const year = yearOf(r);
        releases = await cachedSearch(`movie:${r.id}`, now, async () =>
          relevantReleases(await prowlarrSearch(`${searchText(r.title)}${year ? ` ${year}` : ""}`, "movie"), "movie", r),
        );
      } else {
        const last = await lastAired(r, now);
        if (!last || !(Date.parse(last.airDate) >= cutoff)) continue;
        season = last.season;
        // Results are capped and sorted by relevance: a bare title search of a long-running show
        // fills up with old seasons, a season search misses names the indexers rank differently.
        // Run both and merge.
        releases = await cachedSearch(`tv:${r.id}:S${season}`, now, async () => {
          const bySeason = await prowlarrSearch(`${searchText(r.name)} S${pad(season)}`, "tv");
          await sleep(CONFIG.searchDelayMs);
          const byTitle = await prowlarrSearch(searchText(r.name), "tv");
          const unique = [...new Map([...bySeason, ...byTitle].map((x) => [`${x.indexerId}:${x.guid}`, x])).values()];
          return relevantReleases(unique, "tv", r, { season, cutoff });
        });
      }
      searched++;
      if (searched % 25 === 0) await saveState();
      const best = releases[0];
      if (!best || best.seeders < CONFIG.minSeeders) continue;
      const latest = kind === "tv"
        ? releases.map((x) => x.parsed).sort((a, b) => (b.episode ?? 999) - (a.episode ?? 999))[0]
        : null;
      items.push({
        ...pickMedia(r, kind),
        key: `${kind}:${r.id}`,
        seeders: best.seeders,
        releaseCount: releases.length,
        quality: best.parsed.quality,
        qualities: qualitiesOf(releases, CONFIG.qualityMinSeeders),
        editions: [...new Set(releases.flatMap((x) => x.parsed.editions))],
        releaseName: best.title,
        publishedAt: releases.map((x) => x.publishDate).sort().at(-1),
        seasons: season != null ? [season] : [],
        latest: latest ? `S${pad(latest.season)}${latest.episode != null ? "E" + pad(latest.episode) : ""}` : null,
      });
    } catch (e) {
      errors.push(`${r.title ?? r.name}: ${e.message}`);
    }
  }
  return items;
}

// ---------------------------------------------------------------- refresh cycle

async function refresh() {
  if (running) return;
  running = true;
  const errors = [];
  try {
    if (!CONFIG.prowlarrKey || !CONFIG.seerrKey) throw new Error("Faltan PROWLARR_API_KEY o SEERR_API_KEY en .env");
    const now = Date.now();
    const items = {};
    for (const kind of ["movie", "tv"]) {
      try {
        items[kind] = await collect(kind, now, errors);
      } catch (e) {
        errors.push(`${kind === "movie" ? "Películas" : "Series"}: ${e.message}`);
        items[kind] = kind === "movie" ? view.movies : view.tv;
      }
      view = { ...view, movies: items.movie ?? view.movies, tv: items.tv ?? view.tv };
    }

    // Forget cache entries nobody has asked about in a while.
    for (const [k, v] of Object.entries(state.checks)) if (now - v.checkedAt > 7 * DAY) delete state.checks[k];
    for (const [k, v] of Object.entries(state.shows)) if (now - v.checkedAt > 7 * DAY) delete state.shows[k];

    view = { updatedAt: new Date().toISOString(), error: errors.length ? errors.slice(0, 5).join(" · ") : null, movies: items.movie, tv: items.tv };
    await saveState();
    console.log(`refresh: ${items.movie.length} movies, ${items.tv.length} series${errors.length ? `, ${errors.length} errors` : ""}`);
  } catch (e) {
    view = { ...view, error: e.message };
    console.error("refresh failed:", e.message);
  } finally {
    running = false;
  }
}

// ---------------------------------------------------------------- request

async function request(body) {
  const mediaType = body.mediaType === "tv" ? "tv" : "movie";
  const tmdbId = Number(body.tmdbId);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) throw Object.assign(new Error("tmdbId inválido"), { status: 400 });
  const payload = { mediaType, mediaId: tmdbId };
  if (mediaType === "tv") payload.seasons = Array.isArray(body.seasons) && body.seasons.length ? body.seasons.map(Number) : "all";
  await seerr("/request", { method: "POST", body: JSON.stringify(payload) });
  const d = await seerr(`/${mediaType}/${tmdbId}`).catch(() => null);
  const status = d?.mediaInfo?.status ?? 2;
  for (const list of [view.movies, view.tv]) for (const it of list) if (it.tmdbId === tmdbId && it.mediaType === mediaType) it.status = status;
  return { status };
}

// ---------------------------------------------------------------- details

const detailsCache = new Map();

async function details(type, id) {
  const mediaType = type === "tv" ? "tv" : "movie";
  const tmdbId = Number(id);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) throw Object.assign(new Error("tmdbId inválido"), { status: 400 });
  const key = `${mediaType}:${tmdbId}`;
  const hit = detailsCache.get(key);
  if (hit && Date.now() - hit.at < HOUR) return hit.value;
  const d = await seerr(`/${mediaType}/${tmdbId}`);
  const trailer = (d.relatedVideos ?? []).find((v) => v.type === "Trailer" && v.site === "YouTube") ?? (d.relatedVideos ?? []).find((v) => v.site === "YouTube");
  const crew = d.credits?.crew ?? [];
  const value = {
    tagline: d.tagline || "",
    overview: d.overview || "",
    genres: (d.genres ?? []).map((g) => g.name),
    runtime: mediaType === "movie" ? d.runtime || null : d.episodeRunTime?.[0] || null,
    date: d.releaseDate || d.firstAirDate || null,
    seasons: d.numberOfSeasons ?? null,
    nextEpisode: d.nextEpisodeToAir ? { season: d.nextEpisodeToAir.seasonNumber, episode: d.nextEpisodeToAir.episodeNumber, airDate: d.nextEpisodeToAir.airDate } : null,
    networks: (d.networks ?? []).map((n) => n.name),
    directors: mediaType === "movie" ? crew.filter((c) => c.job === "Director").map((c) => c.name) : (d.createdBy ?? []).map((c) => c.name),
    cast: (d.credits?.cast ?? []).slice(0, 10).map((c) => ({ name: c.name, character: c.character, profilePath: c.profilePath ?? null })),
    trailer: trailer ? `https://www.youtube.com/watch?v=${encodeURIComponent(trailer.key)}` : null,
    status: d.mediaInfo?.status ?? 1,
  };
  detailsCache.set(key, { at: Date.now(), value });
  return value;
}

// ---------------------------------------------------------------- RSS

const esc = (s) => String(s ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);

function rss(kind, req) {
  const list = kind === "movie" ? view.movies : view.tv;
  const seerrBase = CONFIG.seerrPublicUrl || `http://${(req.headers.host || "localhost").split(":")[0]}:8000`;
  const self = `http://${req.headers.host}`;
  const label = kind === "movie" ? "Películas" : "Series";
  const items = list
    .map((it) => {
      const extra = [it.latest, (it.qualities ?? []).map((x) => x.label).join("/") || it.quality, ...it.editions, `${it.seeders} seeders`].filter(Boolean).join(" · ");
      const poster = it.posterPath ? `<img src="https://image.tmdb.org/t/p/w300${it.posterPath}"/><br/>` : "";
      return `<item>
  <title>${esc(`${it.title}${it.year ? ` (${it.year})` : ""} — ${extra}`)}</title>
  <link>${esc(`${seerrBase}/${it.mediaType}/${it.tmdbId}`)}</link>
  <guid isPermaLink="false">${esc(`${it.mediaType}-${it.tmdbId}-${it.latest ?? ""}`)}</guid>
  <pubDate>${new Date(it.publishedAt).toUTCString()}</pubDate>
  <description>${esc(`${poster}${it.overview}`)}</description>
</item>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Available now — ${label}</title>
<link>${esc(self)}</link>
<description>${label} populares recién salidas en torrent</description>
<lastBuildDate>${new Date(view.updatedAt ?? Date.now()).toUTCString()}</lastBuildDate>
${items}
</channel></rss>`;
}

// ---------------------------------------------------------------- HTTP

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && url.pathname === "/api/items") {
      return send(res, 200, { ...view, refreshing: running, seerrPublicUrl: CONFIG.seerrPublicUrl, config: { minSeeders: CONFIG.minSeeders, minVotesMovie: CONFIG.minVotesMovie, minVotesTv: CONFIG.minVotesTv, maxAgeDays: CONFIG.maxAgeDays, movieMaxAgeDays: CONFIG.movieMaxAgeDays } });
    }
    if (req.method === "GET" && url.pathname === "/api/details") {
      return send(res, 200, await details(url.searchParams.get("type"), url.searchParams.get("id")));
    }
    if (req.method === "POST" && url.pathname === "/api/request") {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 10_000) return send(res, 413, { message: "too large" });
      }
      return send(res, 200, await request(JSON.parse(raw || "{}")));
    }
    if (req.method === "GET" && (url.pathname === "/movies.xml" || url.pathname === "/tv.xml")) {
      return send(res, 200, rss(url.pathname === "/movies.xml" ? "movie" : "tv", req), "application/rss+xml; charset=utf-8");
    }
    if (req.method === "GET") {
      const file = url.pathname === "/" ? "index.html" : url.pathname === "/widget" ? "widget.html" : url.pathname.slice(1);
      if (!/^[a-z0-9_-]+\.(html|js|css|svg)$/i.test(file)) return send(res, 404, { message: "not found" });
      const body = await readFile(join(ROOT, "public", file)).catch(() => null);
      if (!body) return send(res, 404, { message: "not found" });
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
      return res.end(body);
    }
    send(res, 405, { message: "method not allowed" });
  } catch (e) {
    send(res, e.status && e.status < 600 ? e.status : 500, { message: e.message });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await loadState();
  server.listen(CONFIG.port, () => console.log(`available-now on :${CONFIG.port}`));
  refresh();
  setInterval(refresh, CONFIG.refreshMinutes * 60_000);
}
