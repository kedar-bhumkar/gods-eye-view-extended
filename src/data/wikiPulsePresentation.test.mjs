import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WIKI_PULSE_OVERLAY_SOURCE_ID,
  classifyEdit,
  createWikiPulseCardEntry,
  describeWikiPulseState,
  redactUser,
} from './wikiPulsePresentation.js';

/** Variants the world-overlay host accepts — mirrors VALID_VARIANTS in
 *  src/overlays/worldOverlay.js. Inlined so this stays a fast pure test. */
const HOST_VARIANTS = new Set(['label', 'track', 'card', 'thumbnail', 'selected', 'tracked']);

// ── redactUser: the load-bearing privacy guard ─────────────────────────────

test('redactUser hides IPv4 addresses', () => {
  assert.equal(redactUser('203.0.113.42'), 'Anonymous editor');
  assert.equal(redactUser('8.8.8.8'), 'Anonymous editor');
});

test('redactUser hides IPv6 addresses', () => {
  assert.equal(redactUser('2001:db8::1'), 'Anonymous editor');
  assert.equal(redactUser('2001:0db8:0000:0000:0000:ff00:0042:8329'), 'Anonymous editor');
});

test('redactUser leaves ordinary usernames alone', () => {
  assert.equal(redactUser('SomeEditor42'), 'SomeEditor42');
  assert.equal(redactUser('Jimbo Wales'), 'Jimbo Wales');
  assert.equal(redactUser('ClueBot NG'), 'ClueBot NG');
});

test('redactUser is total', () => {
  assert.equal(redactUser(null), 'Anonymous editor');
  assert.equal(redactUser(undefined), 'Anonymous editor');
  assert.equal(redactUser(''), 'Anonymous editor');
  assert.equal(redactUser('   '), 'Anonymous editor');
});

// ── classifyEdit ────────────────────────────────────────────────────────────

test('classifyEdit dims and shrinks bot edits relative to human ones', () => {
  const bot = classifyEdit({ bot: true, byteDelta: 500 });
  const human = classifyEdit({ bot: false, byteDelta: 500 });
  assert.equal(bot.isBot, true);
  assert.equal(human.isBot, false);
  assert.notEqual(bot.color, human.color);
  assert.ok(human.dotPx >= bot.dotPx, 'a human edit of the same size must not read smaller than a bot edit');
});

test('classifyEdit scales gently with edit size and never breaks on bad input', () => {
  const tiny = classifyEdit({ bot: false, byteDelta: 0 });
  const large = classifyEdit({ bot: false, byteDelta: 50000 });
  assert.ok(large.dotPx >= tiny.dotPx);
  const junk = classifyEdit({ bot: undefined, byteDelta: 'nonsense' });
  assert.equal(junk.isBot, false);
  assert.ok(Number.isFinite(junk.dotPx));
});

// ── describeWikiPulseState ──────────────────────────────────────────────────

test('describeWikiPulseState names each connection phase', () => {
  assert.match(describeWikiPulseState({ status: 'idle' }), /connecting/);
  assert.match(describeWikiPulseState({ status: 'connecting' }), /connecting/);
  assert.match(describeWikiPulseState({ status: 'degraded', count: 0 }), /reconnecting/);
  assert.match(describeWikiPulseState({ status: 'live', count: 0 }), /no edits observed/);
});

test('describeWikiPulseState reports count, rate, and human share once live', () => {
  const text = describeWikiPulseState({
    status: 'live', count: 42, ratePerMin: 18.4, humanPct: 63.2,
  });
  assert.match(text, /42 edits/);
  assert.match(text, /18\/min/);
  assert.match(text, /63% human/);
});

// ── The bug this file exists to prevent (see news.test.mjs) ────────────────
// entity.description renders nowhere; a click must publish through the world
// overlay and satisfy that host's contract or the card is silently dropped.

const ROW = Object.freeze({
  id: 'abc-123-def',
  title: 'Example (disambiguation)',
  wiki: 'en.wikipedia.org',
  user: 'SomeEditor',
  bot: false,
  byteDelta: 120,
  timestampMs: Date.parse('2026-08-27T09:15:00.000Z'),
});
const POSITION = Object.freeze({ x: 1, y: 2, z: 3 });

test('the selection card satisfies the world-overlay contract', () => {
  const entry = createWikiPulseCardEntry(ROW, POSITION);
  assert.equal(entry.variant, 'card');
  assert.ok(HOST_VARIANTS.has(entry.variant), 'variant must be one the host accepts');
  assert.equal(entry.source, WIKI_PULSE_OVERLAY_SOURCE_ID);
  assert.equal(entry.position, POSITION);
  assert.equal(typeof entry.title, 'string');
  assert.ok(entry.title.length > 0);
  assert.ok(Array.isArray(entry.details) && entry.details.length > 0);
  assert.ok(entry.details.every((line) => typeof line === 'string' && line.length > 0));
});

test('the selection card wins the collision arbiter', () => {
  const entry = createWikiPulseCardEntry(ROW, POSITION);
  assert.equal(entry.paintLane, 'selected');
  assert.equal(entry.protected, true);
  assert.equal(entry.selected, true);
  assert.equal(entry.priority, Number.MAX_SAFE_INTEGER);
});

test('the card carries the edit, its weight, and the illustrative-position disclaimer', () => {
  const entry = createWikiPulseCardEntry(ROW, POSITION);
  assert.equal(entry.title, ROW.title);
  const text = entry.details.join(' | ');
  assert.match(text, /Human edit/);
  assert.match(text, /\+120 bytes/);
  assert.match(text, /en\.wikipedia\.org/);
  assert.match(text, /SomeEditor/);
  assert.match(text, /09:15 UTC/);
  assert.match(text, /illustrative/);
});

test('the card never renders a raw IP address, even if one reaches it', () => {
  const entry = createWikiPulseCardEntry({ ...ROW, user: '198.51.100.7' }, POSITION);
  const text = entry.details.join(' | ');
  assert.ok(!text.includes('198.51.100.7'), 'a raw IP must never reach the card text');
  assert.match(text, /Anonymous editor/);
});

test('a missing byte delta and timestamp are simply absent, not placeholders', () => {
  const entry = createWikiPulseCardEntry({ ...ROW, byteDelta: null, timestampMs: null }, POSITION);
  const text = entry.details.join(' | ');
  assert.ok(!/undefined|null|NaN/.test(text), `no placeholder leakage: ${text}`);
});

test('the card id is namespaced so it cannot collide with a blip', () => {
  const entry = createWikiPulseCardEntry(ROW, POSITION);
  assert.equal(entry.id, `selected:${ROW.id}`);
});
