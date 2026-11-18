import { test } from "node:test";
import assert from "node:assert/strict";
import { sameTitle, relevantReleases, searchText, qualitiesOf } from "../server.mjs";

const rel = (title, seeders = 100, publishDate = "2026-11-10T00:00:00Z") => ({ title, seeders, publishDate, protocol: "torrent" });

test("sameTitle: exact title, either side of a bilingual name, not a prefix", () => {
  const m = { title: "Heart of the Beast", originalTitle: "Heart of the Beast" };
  assert.ok(sameTitle("Heart of the Beast", m));
  assert.ok(sameTitle("Сердце зверя / Heart of the Beast", m));
  assert.ok(sameTitle("Анатомия страсти / Анатомия Грей / Grey's Anatomy /", { name: "Grey's Anatomy" }));
  assert.ok(!sameTitle("Heart of the Beast 2", m));
  assert.ok(sameTitle("Spider-Man Brand New Day", { title: "Spider-Man: Brand New Day" }));
  assert.ok(!sameTitle("Hopeless", { title: "Hope" }));
});

test("relevantReleases: movies need the right year and no cams, sorted by seeders", () => {
  const m = { title: "Hope", releaseDate: "2026-07-15" };
  const out = relevantReleases(
    [rel("Hope.2026.1080p.WEB-DL", 50), rel("Hope.2026.HDCAM", 900), rel("Hope.1997.1080p.BluRay", 999), rel("Hope 2026 2160p WEB", 80), { ...rel("Hope 2026 1080p", 5000), protocol: "usenet" }],
    "movie",
    m,
  );
  assert.deepEqual(out.map((r) => r.seeders), [80, 50]);
});

test("relevantReleases: series need the airing season published since cutoff", () => {
  const s = { name: "American Horror Story" };
  const cutoff = Date.parse("2026-10-28T00:00:00Z");
  const out = relevantReleases(
    [
      rel("American.Horror.Story.S13E13.1080p.WEB.H264-CAKES", 571, "2026-10-30T04:35:02Z"),
      rel("American.Horror.Story.S13E10.1080p.WEB", 932, "2026-10-16T18:57:44Z"),
      rel("American.Horror.Story.S01.1080p.BluRay", 999, "2026-11-10T00:00:00Z"),
    ],
    "tv",
    s,
    { season: 13, cutoff },
  );
  assert.deepEqual(out.map((r) => r.parsed.episode), [13]);
});

test("searchText: punctuation as release names spell it", () => {
  assert.equal(searchText("Grey's Anatomy"), "Greys Anatomy");
  assert.equal(searchText("Law & Order: Special Victims Unit"), "Law and Order Special Victims Unit");
  assert.equal(searchText("Jeopardy!"), "Jeopardy");
});

test("qualitiesOf: 4K and 1080p badges need seeders", () => {
  const r = (quality, seeders) => ({ title: quality, seeders, parsed: { quality } });
  assert.deepEqual(qualitiesOf([r("1080p WEB", 900), r("2160p WEB", 40), r("2160p REMUX", 60), r("720p WEB", 999)], 5).map((q) => [q.label, q.seeders]), [["4K", 60], ["1080p", 900]]);
  assert.deepEqual(qualitiesOf([r("1080p WEB", 900), r("2160p WEB", 2)], 5).map((q) => q.label), ["1080p"]);
});
