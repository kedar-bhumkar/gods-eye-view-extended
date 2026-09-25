import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  NEAREST_COUNTRY_MAX_KM,
  countryAt,
  hashSeed,
  mulberry32,
  pickRingByArea,
  placeArticle,
  placeArticles,
  pointInCountry,
  pointInRing,
} from './newsPlacement.js';

import { fnv1a32 } from './newsPolicy.js';

/** A 10x10 degree square with a small detached island — enough to exercise
 *  ring picking, containment and area weighting without a 3 MB fixture. */
const SQUARE = Object.freeze({
  iso: 'ZZ',
  name: 'Testland',
  bbox: [0, 0, 30, 10],
  areas: [1_200_000, 1_000],
  rings: [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
    [[29, 9], [30, 9], [30, 10], [29, 10], [29, 9]],
  ],
});

test('the seed hash matches newsPolicy, so ids and pins never drift apart', () => {
  for (const sample of ['in-2026-08-24-1f3a9c02', '', 'x', 'a longer article identifier']) {
    assert.equal(hashSeed(sample), fnv1a32(sample), `diverged on ${JSON.stringify(sample)}`);
  }
});

test('mulberry32 is deterministic, bounded, and varies by seed', () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  const first = Array.from({ length: 50 }, () => a());
  const second = Array.from({ length: 50 }, () => b());
  assert.deepEqual(first, second);
  assert.ok(first.every((value) => value >= 0 && value < 1), 'must stay in [0, 1)');
  assert.equal(new Set(first).size, 50, 'no immediate repeats');
  assert.notDeepEqual(first, Array.from({ length: 50 }, mulberry32(12346)));
});

test('pointInRing handles inside, outside and the degenerate cases', () => {
  const ring = SQUARE.rings[0];
  assert.equal(pointInRing(ring, 5, 5), true);
  assert.equal(pointInRing(ring, 15, 5), false);
  assert.equal(pointInRing(ring, 5, -1), false);
  assert.equal(pointInRing([], 5, 5), false);
  assert.equal(pointInRing([[0, 0], [1, 1]], 0.5, 0.5), false, 'two points are not a polygon');
  assert.equal(pointInRing(null, 5, 5), false);
});

test('pointInCountry rejects on bbox before walking rings', () => {
  assert.equal(pointInCountry(SQUARE, 5, 5), true);
  assert.equal(pointInCountry(SQUARE, 9.5, 29.5), true, 'the island counts too');
  assert.equal(pointInCountry(SQUARE, 50, 50), false);
  assert.equal(pointInCountry({ rings: [] }, 5, 5), false);
});

test('countryAt prefers containment, then falls back to the nearest country', () => {
  const countries = [SQUARE];
  const exact = countryAt(countries, 5, 5);
  assert.equal(exact.iso, 'ZZ');
  assert.equal(exact.exact, true);
  assert.equal(exact.distanceKm, 0);

  // Just outside the western edge — the fallback should still resolve.
  const near = countryAt(countries, 5, -0.3);
  assert.equal(near?.iso, 'ZZ');
  assert.equal(near.exact, false);
  assert.ok(near.distanceKm > 0 && near.distanceKm < NEAREST_COUNTRY_MAX_KM);

  assert.equal(countryAt(countries, 5, -40), null, 'far out to sea is honestly nothing');
  assert.equal(countryAt(null, 5, 5), null);
  assert.equal(countryAt(countries, Number.NaN, 5), null);
});

test('placeArticle is deterministic for the same id', () => {
  const first = placeArticle({ id: 'in-2026-08-24-abc12345' }, SQUARE);
  const again = placeArticle({ id: 'in-2026-08-24-abc12345' }, SQUARE);
  assert.deepEqual(first, again);
  assert.equal(first.source, 'scatter');
  assert.equal(pointInCountry(SQUARE, first.lat, first.lon), true);
});

test('different ids land in different places', () => {
  const positions = new Set();
  for (let i = 0; i < 200; i++) {
    const position = placeArticle({ id: `zz-2026-08-24-${i}` }, SQUARE);
    positions.add(`${position.lat},${position.lon}`);
  }
  assert.ok(positions.size > 190, `expected spread, got ${positions.size} distinct of 200`);
});

test('real coordinates on the row beat deterministic scatter', () => {
  const placed = placeArticle({ id: 'x', lat: 19.076, lon: 72.877 }, SQUARE);
  assert.deepEqual(placed, { lat: 19.076, lon: 72.877, source: 'record' });
  const zeroIsland = placeArticle({ id: 'x', lat: 0, lon: 0 }, SQUARE);
  assert.equal(zeroIsland.source, 'scatter', '0,0 is a missing value, not a location');
});

test('area weighting keeps pins off the tiny island', () => {
  const counts = { 0: 0, 1: 0 };
  for (let i = 0; i < 300; i++) {
    const position = placeArticle({ id: `zz-${i}` }, SQUARE);
    counts[pointInRing(SQUARE.rings[1], position.lat, position.lon) ? 1 : 0]++;
  }
  assert.ok(counts[1] <= 3, `island took ${counts[1]} of 300 pins; area weighting is not working`);
});

test('pickRingByArea survives missing or zeroed areas', () => {
  const random = mulberry32(1);
  assert.equal(pickRingByArea({ rings: SQUARE.rings }, random).index >= 0, true);
  assert.equal(pickRingByArea({ rings: SQUARE.rings, areas: [0, 0] }, random).index, 0);
  assert.equal(pickRingByArea({ rings: [] }, random), null);
  assert.equal(pickRingByArea(null, random), null);
});

test('a pin always exists — centroid fallback rather than a dropped article', () => {
  // A ring whose bounding box is almost entirely outside it: rejection
  // sampling cannot succeed within the budget, so the centroid must answer.
  const sliver = {
    iso: 'YY',
    bbox: [0, 0, 100, 100],
    areas: [1],
    rings: [[[0, 0], [100, 99.999], [100, 100], [0, 0.001], [0, 0]]],
  };
  const placed = placeArticle({ id: 'sliver-test' }, sliver, { maxAttempts: 2 });
  assert.ok(placed, 'must never return null for a valid country');
  assert.ok(Number.isFinite(placed.lat) && Number.isFinite(placed.lon));
});

test('placeArticle refuses what it cannot place', () => {
  assert.equal(placeArticle({ id: '' }, SQUARE), null);
  assert.equal(placeArticle({ id: 'x' }, { rings: [] }), null);
  assert.equal(placeArticle({ id: 'x' }, null), null);
});

test('placeArticles reports how every position was arrived at', () => {
  const result = placeArticles([
    { id: 'a' },
    { id: 'b', lat: 5, lon: 5 },
    { id: '' },
  ], SQUARE);
  assert.equal(result.placed.length, 2);
  assert.equal(result.counts.record, 1);
  assert.equal(result.counts.scatter, 1);
  assert.equal(result.counts.failed, 1);
  assert.deepEqual(placeArticles(null, SQUARE).placed, []);
});

// ── Against the bundled Natural Earth polygons ─────────────────────────────

test('real country polygons place real cities and scatter inside real borders', async (t) => {
  let countries;
  try {
    const url = new URL('./local_data/natural_earth/countries.json', import.meta.url);
    countries = JSON.parse(await readFile(url, 'utf8')).countries;
  } catch {
    t.skip('countries.json not built — run scripts/build-country-polygons.mjs');
    return;
  }

  // Camera lookup, including the fallback that generalised coastlines need.
  for (const [name, lat, lon, expected] of [
    ['New Delhi', 28.61, 77.21, 'IN'],
    ['Mumbai', 19.08, 72.88, 'IN'],
    ['New York', 40.71, -74.01, 'US'],
    ['Miami', 25.76, -80.19, 'US'],
    ['Tokyo', 35.68, 139.69, 'JP'],
    ['mid-Atlantic', 30, -40, null],
  ]) {
    assert.equal(countryAt(countries, lat, lon)?.iso ?? null, expected, name);
  }

  // Scatter must stay inside the border, including for the awkward shapes.
  const articles = Array.from({ length: 120 }, (_, i) => ({ id: `xx-2026-08-24-${i}` }));
  for (const iso of ['IN', 'US', 'CL', 'NO', 'ID', 'JP', 'GB']) {
    const country = countries.find((entry) => entry.iso === iso);
    assert.ok(country, `${iso} missing from countries.json`);
    const { placed, counts } = placeArticles(articles, country);
    assert.equal(placed.length, articles.length, `${iso} dropped articles`);
    assert.equal(counts.centroid, 0, `${iso} fell back to centroids`);
    for (const pin of placed) {
      assert.ok(pointInCountry(country, pin.lat, pin.lon), `${iso} pin outside its own border`);
    }
  }
});
