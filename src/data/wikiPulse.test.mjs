// src/data/wikiPulse.test.mjs
// Layer-level tests, in the style of earthquakes.test.mjs's "real lifecycle"
// test: a fake viewer that only implements dataSources.add/remove (Cesium
// geometry itself is real — Cesium.CustomDataSource needs no WebGL context).
//
// `enable()` is deliberately never called here: it constructs a real
// Cesium.ScreenSpaceEventHandler, which requires a browser `document` and
// throws in plain Node. news.js's own test suite avoids this the same way —
// see news.test.mjs's header comment. Click-to-card behavior is covered at
// the presentation-contract level instead, in wikiPulsePresentation.test.mjs.
//
// `update()` registers each blip with contextStore.js, which needs a
// `window` to hang its store on — see contextStore.test.mjs's `withWindow`
// helper, reused here verbatim.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWikiPulseLayer } from './wikiPulse.js';

// Async, unlike contextStore.test.mjs's synchronous original: every callback
// here awaits inside, and a synchronous `finally` would restore `window`
// before the callback's own `await`s ever run, since calling an async
// function only executes up to its first `await` before control returns here.
async function withWindow(run) {
  const realWindow = globalThis.window;
  globalThis.window = new EventTarget();
  try {
    return await run();
  } finally {
    globalThis.window = realWindow;
  }
}

function fakeViewer() {
  const dataSources = [];
  return {
    dataSources: {
      add(dataSource) { dataSources.push(dataSource); return dataSource; },
      remove(dataSource) {
        const index = dataSources.indexOf(dataSource);
        if (index >= 0) dataSources.splice(index, 1);
        return index >= 0;
      },
    },
    _sources: dataSources,
  };
}

const EVENT_A = Object.freeze({
  id: 'evt-a', wiki: 'en.wikipedia.org', title: 'Alpha', user: 'SomeUser', bot: false, byteDelta: 40, timestampMs: 1000,
});
const EVENT_B = Object.freeze({
  id: 'evt-b', wiki: 'de.wikipedia.org', title: 'Beta', user: '203.0.113.9', bot: false, byteDelta: -10, timestampMs: 1001,
});
const EVENT_C_BOT = Object.freeze({
  id: 'evt-c', wiki: 'fr.wikipedia.org', title: 'Gamma', user: 'SomeBot', bot: true, byteDelta: 5, timestampMs: 1002,
});

/** A single big square so placeEvent always succeeds deterministically. */
function fakeCountries() {
  return [{
    iso: 'ZZ', name: 'Testland', bbox: [0, 0, 10, 10], areas: [1_000_000],
    rings: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
  }];
}

test('update() adds one entity per new event and skips duplicates on the next poll', async () => {
  await withWindow(async () => {
    const viewer = fakeViewer();
    let rows = [EVENT_A, EVENT_B];
    const layer = createWikiPulseLayer({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ rows, status: 'live' }) }),
      loadCountries: async () => fakeCountries(),
    });
    await layer.init(viewer);
    await layer.update(viewer);
    assert.equal(viewer._sources[0].entities.values.length, 2);
    assert.equal(layer.getStats().count, 2);

    // Same two ids again plus one new one: only the new one should be added.
    rows = [EVENT_A, EVENT_B, EVENT_C_BOT];
    await layer.update(viewer);
    assert.equal(viewer._sources[0].entities.values.length, 3, 'duplicates must not be re-added');
    assert.equal(layer.getStats().count, 3);
  });
});

test('a raw IP address never reaches an entity context record, even from an unredacted upstream row', async () => {
  await withWindow(async () => {
    const { getContextStore } = await import('./contextStore.js');
    const viewer = fakeViewer();
    const layer = createWikiPulseLayer({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        // Simulates a proxy bug: the raw IP leaks through unredacted.
        json: async () => ({ rows: [{ ...EVENT_B, user: '198.51.100.7' }], status: 'live' }),
      }),
      loadCountries: async () => fakeCountries(),
    });
    await layer.init(viewer);
    await layer.update(viewer);
    const record = getContextStore().entities.get('wiki:evt-b');
    assert.ok(record, 'the blip must register a context record');
    const serialized = JSON.stringify(record.properties);
    assert.ok(!serialized.includes('198.51.100.7'), 'the layer must redact independently of the proxy');
    assert.match(serialized, /Anonymous editor/);
  });
});

test('expired blips are pruned and the selection card clears if the selected blip expires', async () => {
  await withWindow(async () => {
    const viewer = fakeViewer();
    let clock = 0;
    const layer = createWikiPulseLayer({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ rows: [EVENT_A], status: 'live' }) }),
      loadCountries: async () => fakeCountries(),
      pinTtlMs: 1000,
      nowFn: () => clock,
    });
    await layer.init(viewer);
    await layer.update(viewer);
    assert.equal(viewer._sources[0].entities.values.length, 1);

    clock = 2000; // past the 1000ms TTL
    await layer.update(viewer);
    assert.equal(viewer._sources[0].entities.values.length, 0, 'expired blip must be removed');
    assert.equal(layer.getStats().count, 0);
  });
});

test('a hard cap evicts the oldest tracked rows first', async () => {
  await withWindow(async () => {
    const viewer = fakeViewer();
    let currentRows = [];
    const layer = createWikiPulseLayer({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ rows: currentRows, status: 'live' }) }),
      loadCountries: async () => fakeCountries(),
      pinTtlMs: 10_000_000, // effectively no TTL eviction for this test
    });
    await layer.init(viewer);
    // Feed 600 distinct ids across six polls of 100 — over the 500 cap.
    for (let batch = 0; batch < 6; batch++) {
      currentRows = Array.from({ length: 100 }, (_, i) => ({
        id: `evt-${batch}-${i}`, wiki: 'en.wikipedia.org', title: 't', user: 'u', bot: false, byteDelta: 1, timestampMs: batch,
      }));
      // eslint-disable-next-line no-await-in-loop
      await layer.update(viewer);
    }
    assert.equal(viewer._sources[0].entities.values.length, 500, 'must trim to the cap');
    assert.equal(layer.getStats().count, 500);
    // The oldest batch (batch 0) must be the one evicted.
    assert.equal(viewer._sources[0].entities.getById('wiki:evt-0-0'), undefined);
    assert.ok(viewer._sources[0].entities.getById('wiki:evt-5-99'));
  });
});

test('getStats reports a human/bot split and an honest status', async () => {
  await withWindow(async () => {
    const viewer = fakeViewer();
    const layer = createWikiPulseLayer({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ rows: [EVENT_A, EVENT_C_BOT], status: 'live' }) }),
      loadCountries: async () => fakeCountries(),
    });
    await layer.init(viewer);
    await layer.update(viewer);
    const stats = layer.getStats();
    assert.equal(stats.count, 2);
    assert.equal(stats.status, 'live');
    assert.match(stats.meta, /2 edits/);
    assert.match(stats.meta, /50% human/);
  });
});

test('a failed fetch reports an error and leaves prior rows in place', async () => {
  await withWindow(async () => {
    const viewer = fakeViewer();
    let shouldFail = false;
    const layer = createWikiPulseLayer({
      fetchImpl: async () => {
        if (shouldFail) throw new Error('network down');
        return { ok: true, status: 200, json: async () => ({ rows: [EVENT_A], status: 'live' }) };
      },
      loadCountries: async () => fakeCountries(),
    });
    await layer.init(viewer);
    await layer.update(viewer);
    assert.equal(layer.getStats().count, 1);

    shouldFail = true;
    const ok = await layer.update(viewer);
    assert.equal(ok, false);
    assert.ok(layer.getStats().error);
    assert.equal(layer.getStats().count, 1, 'a failed poll must not clear what is already shown');
  });
});
