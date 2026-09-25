// src/data/indianHistoryPresentation.test.mjs
// Dataset integrity + pure presentation helpers for the Indian History layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_KINGDOM,
  ERA_IDS,
  KINGDOM_CHIPS,
  KINGDOM_CODES,
  KINGDOM_IDS,
  createHistoryCardEntry,
  describeIndianHistoryState,
  cityLabelCandidates,
  eventLabelCandidates,
  planLabelLayout,
  formatYear,
  historyLegend,
  isWikipediaUrl,
  orderedEvents,
  validateKingdomData,
  wrapText,
} from './indianHistoryPresentation.js';
import {
  createDefaultLayerState,
  decodeLayerStateParams,
  encodeLayerStateParams,
  normalizeLayerState,
} from './layerState.js';

const DATA = JSON.parse(readFileSync(
  new URL('./local_data/indian_history/kingdoms.json', import.meta.url),
  'utf8',
));

/**
 * Generous South Asia box (to Kabul, Sri Lanka and the Chola raid on Kedah);
 * anything outside is a typo'd coordinate.
 */
function inRegion({ lat, lon }) {
  return lat >= 0 && lat <= 38 && lon >= 58 && lon <= 102;
}

/** Ray-casting point-in-ring test on [lon, lat] rings. */
function inRing([lon, lat], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inExtent(point, kingdom) {
  return kingdom.extents.some((extent) => extent.rings.some((ring) => inRing(point, ring))
    && !(extent.holes || []).some((hole) => inRing(point, hole)));
}

test('bundled dataset is valid and covers every selectable kingdom', () => {
  assert.deepEqual(validateKingdomData(DATA), []);
  // Same set, and the file keeps the chips' chronological order.
  assert.deepEqual(DATA.kingdoms.map((k) => k.id), [...KINGDOM_IDS]);
  const starts = DATA.kingdoms.map((k) => k.period.start);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  assert.equal(new Set(Object.values(KINGDOM_CODES)).size, KINGDOM_IDS.length, 'share-link codes are unique');
  // One or two lowercase characters; never the codec's '.' or '_' separators.
  for (const code of Object.values(KINGDOM_CODES)) assert.match(code, /^[a-z0-9]{1,2}$/);
  // Every chip names a real era, and each era is one contiguous block, in order.
  const eras = KINGDOM_CHIPS.map((chip) => chip.era);
  for (const era of eras) assert.ok(ERA_IDS.includes(era), `unknown era ${era}`);
  assert.deepEqual([...new Set(eras)], [...ERA_IDS]);
  assert.equal(eras.filter((era, i) => i && era !== eras[i - 1]).length, ERA_IDS.length - 1);
  for (const kingdom of DATA.kingdoms) {
    assert.ok(kingdom.cities.some((city) => city.role === 'capital'), `${kingdom.id} has a capital`);
    assert.ok(kingdom.events.length >= 3, `${kingdom.id} has events`);
    for (const item of [kingdom.anchor, ...kingdom.cities, ...kingdom.events]) {
      assert.ok(inRegion(item), `${kingdom.id}: ${item.id || 'anchor'} is inside the region`);
    }
    assert.ok(inExtent([kingdom.anchor.lon, kingdom.anchor.lat], kingdom), `${kingdom.id}: title anchor inside its extent`);
    for (const capital of kingdom.cities.filter((city) => city.role === 'capital')) {
      assert.ok(inExtent([capital.lon, capital.lat], kingdom), `${kingdom.id}: capital ${capital.id} inside its extent`);
    }
    for (const extent of kingdom.extents) {
      for (const ring of [...extent.rings, ...(extent.holes || [])]) {
        for (const [lon, lat] of ring) assert.ok(inRegion({ lat, lon }), `${kingdom.id} ring point ${lon},${lat}`);
      }
    }
  }
});

test('validateKingdomData flags malformed records', () => {
  const broken = structuredClone(DATA);
  const byId = (id) => broken.kingdoms.find((k) => k.id === id);
  byId('nanda').wiki = 'https://example.com/nanda';
  byId('maurya').extents[0].rings[0].pop(); // no longer closed
  byId('gupta').events[0].year = 9999;
  byId('maratha').extents[0].holes[0].pop(); // hole no longer closed
  byId('pandya').extents[0].holes = byId('maratha').extents[0].holes; // holes with two rings
  const problems = validateKingdomData(broken);
  assert.ok(problems.some((p) => /nanda: bad wiki/.test(p)));
  assert.ok(problems.some((p) => /maurya: extent peak ring/.test(p)));
  assert.ok(problems.some((p) => /gupta: event .* year outside period/.test(p)));
  assert.ok(problems.some((p) => /maratha: extent peak ring/.test(p)));
  assert.ok(problems.some((p) => /pandya: extent peak holes need exactly one ring/.test(p)));
  assert.deepEqual(validateKingdomData({}), ['kingdoms must be an array']);
});

test('isWikipediaUrl accepts only English Wikipedia articles', () => {
  assert.equal(isWikipediaUrl('https://en.wikipedia.org/wiki/Gupta_Empire'), true);
  assert.equal(isWikipediaUrl('http://en.wikipedia.org/wiki/Gupta_Empire'), false);
  assert.equal(isWikipediaUrl('javascript:alert(1)'), false);
  assert.equal(isWikipediaUrl('https://en.wikipedia.org.evil.test/wiki/X'), false);
});

test('formatYear handles BCE, CE, and circa', () => {
  assert.equal(formatYear(-261), '261 BCE');
  assert.equal(formatYear(-322, true), 'c. 322 BCE');
  assert.equal(formatYear(499), '499 CE');
  assert.equal(formatYear(Number.NaN), '');
});

test('wrapText keeps every line within the width and loses no words', () => {
  const text = DATA.kingdoms[1].summary;
  const lines = wrapText(text, 30);
  assert.ok(lines.every((line) => line.length <= 30));
  assert.equal(lines.join(' '), text.split(/\s+/).join(' '));
  assert.deepEqual(wrapText(''), []);
});

test('events are numbered chronologically', () => {
  const maurya = DATA.kingdoms.find((k) => k.id === 'maurya');
  const events = orderedEvents(maurya);
  assert.deepEqual(events.map((e) => e.number), events.map((_, i) => i + 1));
  for (let i = 1; i < events.length; i++) assert.ok(events[i - 1].year <= events[i].year);
});

test('planLabelLayout keeps labels apart and hides optional ones without room', () => {
  // Three labels anchored at nearly the same pixel: the first takes its first
  // candidate, the second moves to the next free one, and the optional third
  // (whose only candidate is taken) is hidden.
  const w = 100;
  const h = 18;
  const column = eventLabelCandidates(w, h);
  const plan = planLabelLayout([
    { id: 'a', x: 500, y: 300, w, h, candidates: column },
    { id: 'b', x: 505, y: 302, w, h, candidates: column },
    { id: 'c', x: 500, y: 300, w, h, candidates: [column[0]], optional: true },
  ]);
  const first = plan.get('a');
  const second = plan.get('b');
  assert.deepEqual([first.dx, first.dy, first.show], [0, column[0][1], true]);
  assert.equal(second.show, true);
  const clear = Math.abs((302 + second.dy) - (300 + first.dy)) >= h
    || Math.abs((505 + second.dx) - (500 + first.dx)) >= w;
  assert.ok(clear, 'b sits clear of a');
  assert.equal(plan.get('c').show, false);

  // A mandatory label with no free spot still shows, at its least-bad candidate.
  const forced = planLabelLayout(
    [{ id: 'x', x: 0, y: 0, w, h, candidates: [[0, 0]] }],
    [{ x: 0, y: 0, w: 500, h: 500 }],
  );
  assert.equal(forced.get('x').show, true);
});

test('label candidates start next to the marker', () => {
  const [above, right, left, below] = cityLabelCandidates(80, 16);
  assert.deepEqual(above, [0, -16]);
  assert.deepEqual(below, [0, 16]);
  assert.ok(right[0] > 40 && left[0] < -40);
  const events = eventLabelCandidates(120, 19, 3);
  assert.deepEqual(events[0], [0, 19 / 2 + 7], 'first choice is directly below');
  assert.deepEqual(events[1], [0, -(19 / 2 + 7)], 'then directly above');
  const dist = events.map(([dx, dy]) => Math.hypot(dx, dy));
  for (let i = 2; i < dist.length; i++) assert.ok(dist[i] >= dist[i - 1] - 0.5, 'nearest first');
  assert.ok(events.some(([dx]) => dx > 60) && events.some(([dx]) => dx < -60), 'side spots exist');
});

test('cards carry the Wikipedia link and are interactive', () => {
  const gupta = DATA.kingdoms.find((k) => k.id === 'gupta');
  const position = { x: 1, y: 2, z: 3 };
  const event = orderedEvents(gupta)[0];
  const card = createHistoryCardEntry('event', gupta, event, position);
  assert.equal(card.wiki, event.wiki);
  assert.equal(card.interactive, true);
  assert.equal(card.title, `1. ${event.title}`);
  assert.match(card.details[0], /CE · Gupta Empire$/);
  assert.match(card.details.at(-1), /Wikipedia/);

  const city = createHistoryCardEntry('city', gupta, gupta.cities[0], position);
  assert.equal(city.wiki, gupta.cities[0].wiki);
  const kingdom = createHistoryCardEntry('kingdom', gupta, gupta, position);
  assert.equal(kingdom.wiki, gupta.wiki);
  assert.match(kingdom.details[0], /approximate/);
});

test('status line and legend describe the selected kingdom', () => {
  const nanda = DATA.kingdoms.find((k) => k.id === 'nanda');
  assert.match(describeIndianHistoryState({ kingdom: nanda }), /^Nanda Empire · c\. 345–322 BCE · \d+ cities · \d+ events/);
  assert.equal(describeIndianHistoryState({ loading: true }), 'loading kingdoms…');
  assert.match(describeIndianHistoryState({ error: 'boom' }), /unavailable · boom/);
  const legend = historyLegend(nanda);
  assert.equal(legend.reduce((sum, row) => sum + row.count, 0), nanda.cities.length + nanda.events.length);
});

test('share-link kingdom option agrees with the layer and round-trips', () => {
  assert.equal(createDefaultLayerState().options['indian-history'].kingdom, DEFAULT_KINGDOM);

  const state = normalizeLayerState({
    enabledLayerIds: ['indian-history'],
    options: { 'indian-history': { kingdom: 'gupta' } },
  });
  const params = encodeLayerStateParams(new URLSearchParams([['v', '2']]), state);
  assert.equal(params.get('l'), 'h');
  // Other owners may emit explicit defaults (flights' models3d); only ours matters here.
  assert.ok(params.get('lo').split('_').includes('h.k.g'));
  assert.deepEqual(decodeLayerStateParams(params), state);

  for (const id of KINGDOM_IDS) {
    const roundTrip = decodeLayerStateParams(encodeLayerStateParams(
      new URLSearchParams([['v', '2']]),
      normalizeLayerState({ enabledLayerIds: ['indian-history'], options: { 'indian-history': { kingdom: id } } }),
    ));
    assert.equal(roundTrip.options['indian-history'].kingdom, id);
  }
  // Omitted option falls back to the default kingdom.
  const bare = decodeLayerStateParams(new URLSearchParams('v=2&l=h'));
  assert.equal(bare.options['indian-history'].kingdom, DEFAULT_KINGDOM);
});

test('close hit area sits in the card corner', async () => {
  const { isOverlayCloseHit, overlayCloseRect } = await import('../overlays/worldOverlayDraw.js');
  const rect = { x: 50, y: 20, w: 200, h: 80 };
  const box = overlayCloseRect(rect);
  assert.ok(box.x + box.w <= rect.x + rect.w && box.y >= rect.y);
  assert.equal(isOverlayCloseHit(rect, box.x + box.w / 2, box.y + box.h / 2), true);
  assert.equal(isOverlayCloseHit(rect, rect.x + 20, rect.y + 40), false);
  assert.equal(isOverlayCloseHit(null, 0, 0), false);
});
