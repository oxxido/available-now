"use strict";

// Compact view for a dashboard iframe (Homarr): N posters in a row, then M more titles as text.
//   /widget?type=movie|tv  &n=5  &more=5  &sort=seeders|recent|rating  &owned=1 (include what you already have)
//          &bg=25262b (solid background instead of transparent)
const params = new URLSearchParams(location.search);
const type = params.get("type") === "tv" ? "tv" : "movie";
const n = Math.max(1, Math.min(12, Number(params.get("n")) || 5));
const more = Math.max(0, Math.min(30, Number(params.get("more") ?? 5)));
const includeOwned = params.get("owned") === "1";
const OWNED = new Set([4, 5]);
const SORTS = {
  seeders: (a, b) => b.seeders - a.seeders,
  recent: (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
  rating: (a, b) => b.voteAverage - a.voteAverage || b.voteCount - a.voteCount,
};
const sort = SORTS[params.get("sort")] ?? SORTS.seeders;

document.documentElement.style.setProperty("--n", n);
// ?bg=25262b or ?bg=%2325262b: a solid background, for dashboards where transparency does not work.
const bg = (params.get("bg") ?? "").replace(/^#/, "");
if (/^[0-9a-f]{3,8}$/i.test(bg)) document.documentElement.style.setProperty("--bg", `#${bg}`);

// Links open the full page in a new tab with that title's details.
const link = (it) => {
  const a = document.createElement("a");
  a.href = new URL(`./#${it.mediaType}/${it.tmdbId}`, location.href).href;
  a.target = "_blank";
  a.rel = "noopener";
  a.title = [it.title, it.year, it.latest, (it.qualities ?? []).map((q) => q.label).join(" / ")].filter(Boolean).join(" · ");
  return a;
};

function poster(it) {
  const a = link(it);
  a.className = "p";
  const frame = document.createElement("span");
  frame.className = "frame";
  a.append(frame);
  if (it.posterPath) {
    const img = document.createElement("img");
    img.src = `https://image.tmdb.org/t/p/w342${it.posterPath}`;
    img.alt = it.title;
    frame.append(img);
  } else {
    const d = document.createElement("span");
    d.className = "none";
    d.textContent = it.title;
    frame.append(d);
  }
  const tags = [it.latest, (it.qualities ?? []).some((q) => q.label === "4K") ? "4K" : null].filter(Boolean);
  if (tags.length) {
    const t = document.createElement("span");
    t.className = "tags";
    for (const tag of tags) {
      const b = document.createElement("b");
      b.textContent = tag;
      if (tag === "4K") b.className = "q4k";
      t.append(b);
    }
    frame.append(t);
  }
  return a;
}

async function load() {
  try {
    const res = await fetch("api/items");
    const data = await res.json();
    const list = (type === "tv" ? data.tv : data.movies).filter((it) => includeOwned || !OWNED.has(it.status)).sort(sort);
    document.getElementById("posters").replaceChildren(...list.slice(0, n).map(poster));
    const rest = list.slice(n, n + more);
    const p = document.getElementById("more");
    p.hidden = !rest.length;
    p.replaceChildren(
      ...rest.flatMap((it, i) => {
        const a = link(it);
        a.textContent = it.title;
        return i ? [document.createTextNode(" · "), a] : [a];
      }),
    );
    if (!list.length) document.getElementById("posters").textContent = data.updatedAt ? "Nada nuevo por ahora." : "Buscando torrents…";
    if (!data.updatedAt || data.refreshing) setTimeout(load, 30_000);
  } catch {
    setTimeout(load, 60_000);
  }
}

load();
setInterval(load, 10 * 60_000);
