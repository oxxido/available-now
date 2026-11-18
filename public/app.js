"use strict";

// Seerr's MediaStatus: 1 unknown, 2 pending, 3 processing, 4 partially available, 5 available.
const STATUS = {
  2: { cls: "pending", label: "Pedida", icon: '<path d="M10 2a6 6 0 0 0-6 6v3.6l-1.7 2.6A1 1 0 0 0 3.1 16h13.8a1 1 0 0 0 .8-1.8L16 11.6V8a6 6 0 0 0-6-6Zm0 18a3 3 0 0 0 2.8-2H7.2A3 3 0 0 0 10 20Z"/>' },
  3: { cls: "processing", label: "Procesando", icon: '<path d="M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm1 4a1 1 0 1 0-2 0v4c0 .3.1.5.3.7l2.5 2.5a1 1 0 0 0 1.4-1.4L11 9.6V6Z"/>' },
  4: { cls: "partial", label: "Parcialmente disponible", icon: '<path d="M5 9h10a1 1 0 1 1 0 2H5a1 1 0 1 1 0-2Z"/>' },
  5: { cls: "available", label: "Disponible", icon: '<path d="M16.7 5.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L8 12.6l7.3-7.3a1 1 0 0 1 1.4 0Z"/>' },
};
const OWNED = new Set([4, 5]);

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const hideOwned = document.getElementById("hide-owned");
const sortSel = document.getElementById("sort");
hideOwned.checked = store.get("hideOwned", true);
sortSel.value = store.get("sort", "seeders");

let data = null;

const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10_000 ? 0 : 1) + "k" : String(n));
const ago = (iso) => {
  const h = Math.round((Date.now() - Date.parse(iso)) / 3_600_000);
  return h < 1 ? "hace un momento" : h < 48 ? `hace ${h} h` : `hace ${Math.round(h / 24)} días`;
};

function seerrUrl(it) {
  const base = data.seerrPublicUrl || `${location.protocol}//${location.hostname}:8000`;
  return `${base}/${it.mediaType}/${it.tmdbId}`;
}

function toast(text, error = false) {
  const el = document.createElement("div");
  el.className = "toast" + (error ? " error" : "");
  el.textContent = text;
  document.getElementById("toasts").append(el);
  setTimeout(() => el.remove(), 5000);
}

function setRequestButton(btn, it) {
  const s = STATUS[it.status];
  const requestable = !it.status || it.status === 1 || (it.mediaType === "tv" && it.status === 4);
  btn.disabled = !requestable;
  btn.classList.toggle("done", !requestable);
  btn.querySelector(".label").textContent = requestable
    ? it.mediaType === "tv" && it.seasons.length
      ? `Pedir ${it.seasons.map((n) => "T" + n).join(", ")}`
      : "Pedir"
    : s?.label ?? "Pedida";
}

function setStatus(card, it) {
  const badge = card.querySelector(".status");
  const s = STATUS[it.status];
  badge.hidden = !s;
  if (s) {
    badge.className = "status " + s.cls;
    badge.title = s.label;
    badge.innerHTML = `<svg viewBox="0 0 20 20" fill="#fff" aria-hidden="true">${s.icon}</svg>`;
  }
  setRequestButton(card.querySelector(".request"), it);
}

// Shared by the card and the details dialog: both buttons reflect the new status.
async function requestTitle(it, buttons) {
  for (const btn of buttons) {
    btn.disabled = true;
    btn.querySelector(".label").textContent = "Pidiendo…";
  }
  try {
    const res = await fetch("api/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mediaType: it.mediaType, tmdbId: it.tmdbId, seasons: it.seasons }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `Error ${res.status}`);
    it.status = body.status;
    toast(`${it.title} pedida en Seerr`);
  } catch (e) {
    toast(`No se pudo pedir ${it.title}: ${e.message}`, true);
  }
  for (const btn of buttons) setRequestButton(btn, it);
  render();
}

const qualities = (it) => (it.qualities?.length ? it.qualities.map((q) => q.label) : [it.quality].filter(Boolean));

function badge(text, cls) {
  const b = document.createElement("b");
  b.textContent = text;
  if (cls) b.className = cls;
  return b;
}

function card(it) {
  const node = document.getElementById("card").content.firstElementChild.cloneNode(true);
  const img = node.querySelector(".poster");
  if (it.posterPath) {
    img.src = `https://image.tmdb.org/t/p/w342${it.posterPath}`;
    img.onerror = () => node.classList.add("no-image");
  } else node.classList.add("no-image");
  node.querySelector(".noposter").textContent = it.title;

  const type = node.querySelector(".type");
  type.className = "type " + it.mediaType;
  type.textContent = it.mediaType === "movie" ? "Película" : "Serie";

  const meta = node.querySelector(".meta");
  meta.append(badge(`▲ ${fmt(it.seeders)}`, "seed"));
  if (it.latest) meta.append(badge(it.latest));
  for (const q of qualities(it)) meta.append(badge(q, q === "4K" ? "q4k" : "q"));
  for (const e of it.editions) meta.append(badge(e));

  const info = node.querySelector(".info");
  info.title = `${it.releaseName}\n${it.releaseCount} releases · publicado ${ago(it.publishedAt)}`;
  node.querySelector(".year").textContent = [it.year, it.voteAverage ? `★ ${it.voteAverage.toFixed(1)}` : null].filter(Boolean).join(" · ");
  node.querySelector(".title").textContent = it.title;
  node.querySelector(".tags").textContent = [it.latest, ...qualities(it), ...it.editions, `${it.seeders} seeders`].filter(Boolean).join(" · ");
  node.querySelector(".overview").textContent = it.overview;

  const btn = node.querySelector(".request");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    requestTitle(it, [btn]);
  });
  node.addEventListener("click", () => openDetails(it));
  node.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target === node) {
      e.preventDefault();
      openDetails(it);
    }
  });

  setStatus(node, it);
  return node;
}

// ---------------------------------------------------------------- details dialog

const dialog = document.getElementById("details");
const dq = (sel) => dialog.querySelector(sel);
let shown = null;

function li(cls, ...children) {
  const el = document.createElement("li");
  if (cls) el.className = cls;
  el.append(...children);
  return el;
}

function span(text, cls) {
  const el = document.createElement("span");
  el.textContent = text;
  if (cls) el.className = cls;
  return el;
}

function fillFacts(it, d) {
  const runtime = d?.runtime ? (d.runtime >= 60 ? `${Math.floor(d.runtime / 60)} h ${d.runtime % 60} min` : `${d.runtime} min`) : null;
  dq(".d-facts").textContent = [
    it.year,
    runtime,
    d?.genres?.join(", "),
    it.voteAverage ? `★ ${it.voteAverage.toFixed(1)} (${fmt(it.voteCount)} votos)` : null,
  ].filter(Boolean).join(" · ");
  dq(".d-tagline").textContent = d?.tagline ?? "";

  const grid = dq(".d-grid");
  grid.replaceChildren();
  const row = (k, v) => {
    if (!v) return;
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    grid.append(dt, dd);
  };
  row(it.mediaType === "movie" ? "Dirección" : "Creada por", d?.directors?.join(", "));
  if (it.mediaType === "tv") {
    row("Último en torrent", it.latest);
    row("Temporadas", d?.seasons);
    row("Próximo episodio", d?.nextEpisode ? `S${String(d.nextEpisode.season).padStart(2, "0")}E${String(d.nextEpisode.episode).padStart(2, "0")} · ${d.nextEpisode.airDate}` : null);
    row("Cadena", d?.networks?.join(", "));
  } else {
    row("Estreno", d?.date);
  }
  row("Publicado", ago(it.publishedAt));

  const trailer = dq(".d-trailer");
  trailer.hidden = !d?.trailer;
  if (d?.trailer) trailer.href = d.trailer;

  const cast = (d?.cast ?? []).map((c) => {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = "";
    if (c.profilePath) img.src = `https://image.tmdb.org/t/p/w185${c.profilePath}`;
    else img.className = "none";
    return li("", img, span(c.name, "c-name"), span(c.character ?? "", "c-role"));
  });
  dq(".d-cast").replaceChildren(...cast);
  dq(".d-cast-h").hidden = !cast.length;
}

async function openDetails(it) {
  shown = it;
  dialog.classList.toggle("tv", it.mediaType === "tv");
  const backdrop = dq(".d-backdrop");
  backdrop.hidden = !it.backdropPath;
  if (it.backdropPath) backdrop.src = `https://image.tmdb.org/t/p/w1280${it.backdropPath}`;
  const poster = dq(".d-poster");
  poster.hidden = !it.posterPath;
  if (it.posterPath) poster.src = `https://image.tmdb.org/t/p/w342${it.posterPath}`;
  dq(".d-type").textContent = it.mediaType === "movie" ? "Película" : "Serie";
  dq(".d-type").className = "d-type type " + it.mediaType;
  dq(".d-title").textContent = it.title;
  dq(".d-overview").textContent = it.overview;
  dq(".d-seerr").href = seerrUrl(it);

  const releases = (it.qualities?.length ? it.qualities : [{ label: it.quality, seeders: it.seeders, releaseName: it.releaseName }]).map((q) =>
    li("", badge(q.label || "—", q.label === "4K" ? "q4k" : "q"), span(`▲ ${fmt(q.seeders)}`, "r-seed"), span(q.releaseName, "r-name")),
  );
  dq(".d-releases").replaceChildren(...releases);

  const btn = dq(".request");
  setRequestButton(btn, it);
  btn.onclick = () => requestTitle(it, [btn]);

  fillFacts(it, null);
  dq(".d-tagline").textContent = "Cargando…";
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;

  try {
    const res = await fetch(`api/details?type=${it.mediaType}&id=${it.tmdbId}`);
    const d = await res.json();
    if (!res.ok) throw new Error(d.message || `Error ${res.status}`);
    if (shown !== it) return;
    if (d.overview) dq(".d-overview").textContent = d.overview;
    if (d.status && d.status !== it.status) {
      it.status = d.status;
      setRequestButton(btn, it);
      render();
    }
    fillFacts(it, d);
  } catch (e) {
    if (shown === it) dq(".d-tagline").textContent = `No se pudo cargar la ficha: ${e.message}`;
  }
}

dq(".d-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) dialog.close();
});
dialog.addEventListener("close", () => {
  shown = null;
});

const SORTS = {
  seeders: (a, b) => b.seeders - a.seeders,
  recent: (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
  rating: (a, b) => b.voteAverage - a.voteAverage || b.voteCount - a.voteCount,
};

function render() {
  if (!data) return;
  for (const section of document.querySelectorAll(".slider")) {
    const list = (section.dataset.kind === "movie" ? data.movies : data.tv)
      .filter((it) => !(hideOwned.checked && OWNED.has(it.status)))
      .sort(SORTS[sortSel.value]);
    const row = section.querySelector(".row");
    row.replaceChildren(...list.map(card));
    if (!list.length) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = data.updatedAt ? "Nada por aquí con los filtros actuales." : "Buscando torrents… la primera pasada puede tardar unos minutos.";
      row.append(p);
    }
    section.querySelector(".count").textContent = list.length ? `· ${list.length}` : "";
  }

  const banner = document.getElementById("banner");
  banner.hidden = !data.error;
  banner.textContent = data.error ? `⚠ ${data.error}` : "";

  const c = data.config;
  document.getElementById("footer").textContent =
    (data.updatedAt ? `Actualizado ${ago(data.updatedAt)}` : "Sin datos todavía") +
    (data.refreshing ? " · actualizando…" : "") +
    ` · películas de los últimos ${c.movieMaxAgeDays} días, series con episodios en los últimos ${c.maxAgeDays} días, ≥ ${c.minSeeders} seeders, ≥ ${c.minVotesMovie} votos TMDB (series ≥ ${c.minVotesTv})`;
}

async function load() {
  try {
    const res = await fetch("api/items");
    data = await res.json();
    render();
    if (!data.updatedAt || data.refreshing) setTimeout(load, 15_000);
  } catch (e) {
    toast(`No se pudo cargar la lista: ${e.message}`, true);
  }
}

hideOwned.addEventListener("change", () => { store.set("hideOwned", hideOwned.checked); render(); });
sortSel.addEventListener("change", () => { store.set("sort", sortSel.value); render(); });
for (const btn of document.querySelectorAll(".view-all")) {
  btn.addEventListener("click", () => {
    const section = btn.closest(".slider");
    const grid = section.classList.toggle("grid");
    btn.firstChild.textContent = grid ? "Ver menos " : "Ver todo ";
  });
}

load();
setInterval(load, 10 * 60_000);
