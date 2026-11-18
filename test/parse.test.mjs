import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRelease } from "../server.mjs";

const movie = (n) => parseRelease(n, "movie");
const tv = (n) => parseRelease(n, "tv");

test("movies: title and year", () => {
  assert.deepEqual(
    (({ title, year, quality }) => ({ title, year, quality }))(movie("Project.Hail.Mary.2026.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX")),
    { title: "Project Hail Mary", year: 2026, quality: "2160p WEB" },
  );
  assert.equal(movie("2001.A.Space.Odyssey.1968.REMASTERED.1080p.BluRay.x264").year, 1968);
  assert.equal(movie("2001.A.Space.Odyssey.1968.REMASTERED.1080p.BluRay.x264").title, "2001 A Space Odyssey");
  assert.deepEqual(movie("E.T. the Extra-Terrestrial (1982) 45th Anniversary Edition 2160p UHD BluRay REMUX").editions, ["Anniversary"]);
  assert.equal(movie("E.T. the Extra-Terrestrial (1982) 45th Anniversary Edition 2160p UHD BluRay REMUX").quality, "2160p REMUX");
  assert.equal(movie("Blade Runner 2049 (2017) 1080p BluRay").title, "Blade Runner 2049");
  assert.equal(movie("[ www.Torrenting.com ] - Dune Part Two 2024 1080p WEB").title, "Dune Part Two");
});

test("movies: junk and unparseable are dropped", () => {
  assert.equal(movie("Mortal.Kombat.II.2026.HDCAM.x264-NOGRP"), null);
  assert.equal(movie("Some Movie 2026 HDTS 720p"), null);
  assert.equal(movie("Some Movie 2026 1080p TELESYNC"), null);
  assert.equal(movie("No year at all 1080p"), null);
});

test("series: title, season, episode", () => {
  const a = tv("The.Last.of.Us.S02E05.1080p.WEB.h264-ETHEL");
  assert.equal(a.title, "The Last of Us");
  assert.equal(a.season, 2);
  assert.equal(a.episode, 5);
  const b = tv("Severance (2022) S02 2160p ATVP WEB-DL");
  assert.equal(b.title, "Severance");
  assert.equal(b.year, 2022);
  assert.equal(b.episode, null);
  assert.equal(tv("Andor Season 2 1080p").season, 2);
  assert.equal(tv("Doctor.Who.2023.S01E03.720p").title, "Doctor Who");
});
