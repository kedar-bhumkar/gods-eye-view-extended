import test from 'node:test';
import assert from 'node:assert/strict';

// Deliberately the Cesium-free module: importing `news.js` would pull in the
// whole 3D engine to test four pure functions.
import {
  MAX_PINS,
  NEWS_OVERLAY_SOURCE_ID,
  chooseImpactFloor,
  createNewsCardEntry,
  describeNewsState,
} from './newsPresentation.js';
import { impactBand } from './newsPolicy.js';

/** Variants the world-overlay host accepts — mirrors VALID_VARIANTS in
 *  src/overlays/worldOverlay.js. Inlined so this stays a fast pure test. */
const HOST_VARIANTS = new Set(['label', 'track', 'card', 'thumbnail', 'selected', 'tracked']);

/** A day shaped like the real India data: a steep pyramid with a long tail. */
function realisticDay() {
  const rows = [];
  const shape = { 5: 14, 4: 23, 3: 503, 2: 740, 1: 5224 };
  for (const [impact, count] of Object.entries(shape)) {
    for (let i = 0; i < count; i++) rows.push({ id: `r${impact}-${i}`, impact: Number(impact) });
  }
  return rows;
}

test('the impact floor rises until the day fits the pin budget', () => {
  const { floor, shown, hidden } = chooseImpactFloor(realisticDay());
  assert.ok(shown <= MAX_PINS, `drew ${shown}, budget is ${MAX_PINS}`);
  assert.equal(floor, 4, '5+4 = 37 fits; adding impact 3 would be 540, over the 400 budget');
  assert.equal(shown, 37, 'only impact 5 and 4 fit');
  assert.equal(hidden, 6504 - 37);
});

test('a quiet day shows everything and hides nothing', () => {
  const rows = [{ impact: 5 }, { impact: 3 }, { impact: 1 }];
  assert.deepEqual(chooseImpactFloor(rows), { floor: 1, shown: 3, hidden: 0 });
});

test('chooseImpactFloor is total', () => {
  assert.deepEqual(chooseImpactFloor([]), { floor: 1, shown: 0, hidden: 0 });
  assert.deepEqual(chooseImpactFloor(null), { floor: 1, shown: 0, hidden: 0 });
  assert.equal(chooseImpactFloor([{ impact: 'nonsense' }]).shown, 1, 'a junk impact still counts as 1');
  const tight = chooseImpactFloor(realisticDay(), 5);
  assert.ok(tight.shown <= 5);
});

test('the meta line states what is drawn and what is held back', () => {
  assert.match(describeNewsState({ country: 'IN', day: '2026-08-26', shown: 37, hidden: 6467 }), /IN.*2026-08-26.*37 pinned.*6467 lower-impact hidden/);
  assert.match(describeNewsState({ country: 'IN', day: '2026-08-26', shown: 0, hidden: 0 }), /nothing ingested/);
  assert.match(describeNewsState({ country: null }), /fly over a country/);
  assert.match(describeNewsState({ unavailable: true }), /news-ingest/, 'a missing database names the fix');
});

// ── The bug this file exists for ───────────────────────────────────────────
// The viewer is built with `infoBox: false`, so `entity.description` renders
// nowhere. Clicking a pin has to publish through the world overlay instead,
// and the entry has to satisfy that host's contract or it is silently dropped.

const ROW = Object.freeze({
  id: 'in-2026-08-26-1f3a9c02',
  title: 'US pauses visa appointments worldwide amid Trump immigration crackdown',
  source: 'thehindu.com',
  impact: 5,
  distinctDomains: 14,
  publishedAt: '2026-08-26T09:15:00.000Z',
  lat: 20.99,
  lon: 74.99,
});
const POSITION = Object.freeze({ x: 1, y: 2, z: 3 });

test('the selection card satisfies the world-overlay contract', () => {
  const entry = createNewsCardEntry(ROW, POSITION);
  assert.equal(entry.variant, 'card', 'card is the variant that paints title + details');
  assert.equal(entry.source, NEWS_OVERLAY_SOURCE_ID);
  assert.ok(HOST_VARIANTS.has(entry.variant), 'variant must be one the host accepts');
  assert.equal(entry.position, POSITION);
  assert.equal(typeof entry.title, 'string');
  assert.ok(entry.title.length > 0);
  assert.ok(Array.isArray(entry.details) && entry.details.length > 0, 'details must be an array of lines');
  assert.ok(entry.details.every((line) => typeof line === 'string' && line.length > 0));
});

test('the selection card wins the collision arbiter', () => {
  const entry = createNewsCardEntry(ROW, POSITION);
  // paintLaneForOverlayEntry() honours an explicit paintLane above every
  // variant default, so this puts the clicked card in the protected lane
  // rather than letting it compete as an ambient card.
  assert.equal(entry.paintLane, 'selected', 'the one thing the operator clicked must not be dropped');
  assert.equal(entry.protected, true);
  assert.equal(entry.selected, true);
  assert.equal(entry.priority, Number.MAX_SAFE_INTEGER);
});

test('the card carries the story, its weight, and an honesty note', () => {
  const entry = createNewsCardEntry(ROW, POSITION);
  assert.equal(entry.title, ROW.title);
  const text = entry.details.join(' | ');
  assert.match(text, /CRITICAL/, 'impact band');
  assert.match(text, /14 outlets/, 'how many outlets carried it');
  assert.match(text, /thehindu\.com/, 'the publisher');
  assert.match(text, /09:15 UTC/, 'when');
  assert.match(text, /scattered within country/, 'the pin must never imply it is the event location');
  assert.equal(entry.accent, impactBand(5).color);
});

test('one outlet is singular, and a missing timestamp is simply absent', () => {
  const entry = createNewsCardEntry({ ...ROW, distinctDomains: 1, publishedAt: null }, POSITION);
  const text = entry.details.join(' | ');
  assert.match(text, /1 outlet\b/);
  assert.ok(!/undefined|null|NaN/.test(text), `no placeholder leakage: ${text}`);
});

test('the card id is namespaced so it cannot collide with a pin', () => {
  const entry = createNewsCardEntry(ROW, POSITION);
  assert.equal(entry.id, `selected:${ROW.id}`);
});
