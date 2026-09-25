import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { mulberry32, pickCountryByArea, placeEvent } from './wikiPulsePlacement.js';
import { pointInCountry } from './newsPlacement.js';

/** Two tiny countries, one ~1000x the land area of the other. */
const BIG = Object.freeze({
  iso: 'ZB', name: 'Bigland', bbox: [0, 0, 10, 10], areas: [1_000_000],
  rings: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
});
const SMALL = Object.freeze({
  iso: 'ZS', name: 'Smallisle', bbox: [20, 0, 21, 1], areas: [1_000],
  rings: [[[20, 0], [21, 0], [21, 1], [20, 1], [20, 0]]],
});
const COUNTRIES = Object.freeze([BIG, SMALL]);

test('pickCountryByArea favors the larger country by roughly its area share', () => {
  const random = mulberry32(7);
  const counts = { ZB: 0, ZS: 0 };
  for (let i = 0; i < 500; i++) counts[pickCountryByArea(COUNTRIES, random).iso]++;
  assert.ok(counts.ZB > 480, `expected Bigland to dominate, got ${JSON.stringify(counts)}`);
});

test('pickCountryByArea is total', () => {
  const random = mulberry32(1);
  assert.equal(pickCountryByArea([], random), null);
  assert.equal(pickCountryByArea(null, random), null);
  // Zeroed areas still returns something rather than nothing.
  const zeroed = [{ iso: 'ZZ', areas: [0, 0], rings: [] }];
  assert.equal(pickCountryByArea(zeroed, random)?.iso, 'ZZ');
});

test('placeEvent is deterministic for the same id', () => {
  const first = placeEvent({ id: 'evt-abc123' }, COUNTRIES);
  const again = placeEvent({ id: 'evt-abc123' }, COUNTRIES);
  assert.deepEqual(first, again);
  assert.ok(['ZB', 'ZS'].includes(first.countryIso));
});

test('different ids scatter across both countries over many trials', () => {
  const countries = new Set();
  for (let i = 0; i < 300; i++) countries.add(placeEvent({ id: `evt-${i}` }, COUNTRIES).countryIso);
  assert.deepEqual(countries, new Set(['ZB', 'ZS']), 'both countries should appear given enough draws');
});

test('placeEvent refuses what it cannot place', () => {
  assert.equal(placeEvent({ id: '' }, COUNTRIES), null);
  assert.equal(placeEvent({ id: 'x' }, []), null);
  assert.equal(placeEvent({ id: 'x' }, null), null);
  assert.equal(placeEvent(null, COUNTRIES), null);
});

// ── Against the bundled Natural Earth polygons ─────────────────────────────

test('real country polygons: every placed blip lands inside some real country', async (t) => {
  let countries;
  try {
    const url = new URL('./local_data/natural_earth/countries.json', import.meta.url);
    countries = JSON.parse(await readFile(url, 'utf8')).countries;
  } catch {
    t.skip('countries.json not built — run scripts/build-country-polygons.mjs');
    return;
  }

  let bigger = 0;
  let smaller = 0;
  const big = countries.find((c) => c.iso === 'RU') || countries.find((c) => c.iso === 'CA');
  const small = countries.find((c) => c.iso === 'LU') || countries.find((c) => c.iso === 'SG');
  for (let i = 0; i < 400; i++) {
    const placed = placeEvent({ id: `wiki-${i}` }, countries);
    assert.ok(placed, 'must always place a valid event');
    const country = countries.find((c) => c.iso === placed.countryIso);
    assert.ok(country, 'placed country must exist in the list');
    assert.ok(pointInCountry(country, placed.lat, placed.lon), `${placed.countryIso} blip fell outside its own border`);
    if (big && placed.countryIso === big.iso) bigger++;
    if (small && placed.countryIso === small.iso) smaller++;
  }
  if (big && small) {
    assert.ok(bigger >= smaller, `${big.iso} (large) should be picked at least as often as ${small.iso} (tiny) over 400 draws`);
  }
});
