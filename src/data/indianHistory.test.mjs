// src/data/indianHistory.test.mjs
// Layer lifecycle tests with a fake viewer (Cesium.CustomDataSource needs no
// WebGL), an injected click-handler factory (the real ScreenSpaceEventHandler
// needs a browser `document`), and an injected overlay host. contextStore.js
// needs a `window`, supplied by the same `withWindow` helper as
// wikiPulse.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createIndianHistoryLayer } from './indianHistory.js';
import { ERA_IDS, KINGDOM_CHIPS } from './indianHistoryPresentation.js';

const DATA = JSON.parse(readFileSync(
  new URL('./local_data/indian_history/kingdoms.json', import.meta.url),
  'utf8',
));

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
  const flights = [];
  return {
    dataSources: {
      add(dataSource) { dataSources.push(dataSource); return dataSource; },
      remove(dataSource) {
        const index = dataSources.indexOf(dataSource);
        if (index >= 0) dataSources.splice(index, 1);
        return index >= 0;
      },
    },
    camera: { flyTo(options) { flights.push(options); } },
    scene: { pick: () => null },
    _sources: dataSources,
    _flights: flights,
  };
}

function fakeHarness() {
  const overlay = { entries: new Map(), hit: null };
  const handlers = [];
  const opened = [];
  const deps = {
    loadData: async () => structuredClone(DATA),
    openUrl: (url) => opened.push(url),
    overlayHost: {
      setEntries: (source, entries) => overlay.entries.set(source, entries),
      setVisible: () => {},
      clearSource: (source) => overlay.entries.delete(source),
      hitTest: () => overlay.hit,
    },
    screenSpaceEventHandlerFactory: () => {
      const handler = {
        action: null,
        destroyed: false,
        setInputAction(action) { this.action = action; },
        destroy() { this.destroyed = true; },
      };
      handlers.push(handler);
      return handler;
    },
  };
  return { deps, overlay, handlers, opened };
}

function entityIds(viewer) {
  return viewer._sources[0].entities.values.map((entity) => entity.id);
}

test('enable + update renders the default kingdom (Maurya) once', async () => {
  await withWindow(async () => {
    const viewer = fakeViewer();
    const { deps } = fakeHarness();
    const layer = createIndianHistoryLayer(deps);
    await layer.init(viewer);
    await layer.enable(viewer);
    assert.equal(await layer.update(viewer), true);

    const maurya = DATA.kingdoms.find((k) => k.id === 'maurya');
    const ids = entityIds(viewer);
    assert.ok(ids.includes('history:maurya:extent:0:0'));
    assert.ok(ids.includes('history:maurya:city:pataliputra'));
    assert.ok(ids.includes('history:maurya:event:kalinga-war'));
    assert.equal(layer.getStats().count, maurya.cities.length + maurya.events.length);
    assert.match(layer.getStats().meta, /^Maurya Empire/);

    // A second update with the same kingdom must not rebuild the entities.
    const first = viewer._sources[0].entities.getById('history:maurya:title');
    await layer.update(viewer);
    assert.equal(viewer._sources[0].entities.getById('history:maurya:title'), first);
    assert.deepEqual(viewer._flights, [], 'enable never moves the camera');
  });
});

test('setParams swaps kingdoms, rejects unknown ids, and flies only on user origin', async () => {
  await withWindow(async () => {
    const viewer = fakeViewer();
    const { deps } = fakeHarness();
    const layer = createIndianHistoryLayer(deps);
    await layer.init(viewer);
    await layer.enable(viewer);
    await layer.update(viewer);

    assert.equal(layer.setParams({ kingdom: 'gupta' }, { origin: 'share-restore' }), true);
    assert.deepEqual(layer.getParams(), { kingdom: 'gupta' });
    const ids = entityIds(viewer);
    assert.ok(ids.every((id) => id.startsWith('history:gupta:')));
    assert.equal(viewer._flights.length, 0);

    assert.equal(layer.setParams({ kingdom: 'nanda' }, { origin: 'user' }), true);
    assert.ok(entityIds(viewer).every((id) => id.startsWith('history:nanda:')));
    assert.equal(viewer._flights.length, 1);

    assert.equal(layer.setParams({ kingdom: 'atlantis' }), false);
    assert.deepEqual(layer.getParams(), { kingdom: 'nanda' });

    // Era chips first, then only the open era's rulers; Nanda opens 'ancient'.
    const idsOfEra = (era) => KINGDOM_CHIPS.filter((c) => c.era === era).map((c) => c.id);
    let chips = layer.getRowControls().chips;
    assert.deepEqual(chips.map((c) => c.id), [...ERA_IDS.map((e) => `era:${e}`), ...idsOfEra('ancient')]);
    assert.deepEqual(chips.filter((c) => c.active).map((c) => c.id), ['era:ancient', 'nanda']);

    // Browsing an era lists its rulers but keeps the shown kingdom (and the camera).
    const flightsBefore = viewer._flights.length;
    assert.equal(layer.setParams({ era: 'early-modern' }, { origin: 'user' }), true);
    chips = layer.getRowControls().chips;
    assert.ok(chips.some((c) => c.id === 'mughal') && !chips.some((c) => c.id === 'nanda'));
    assert.deepEqual(layer.getParams(), { kingdom: 'nanda' });
    assert.equal(viewer._flights.length, flightsBefore);
    assert.ok(entityIds(viewer).every((id) => id.startsWith('history:nanda:')));
    assert.equal(layer.setParams({ era: 'bronze-age' }), false);

    // Picking a ruler from that era swaps the map.
    assert.equal(layer.setParams({ kingdom: 'mughal' }, { origin: 'user' }), true);
    assert.ok(entityIds(viewer).every((id) => id.startsWith('history:mughal:')));
  });
});

test('params applied before enable (restore path) render on the first update', async () => {
  await withWindow(async () => {
    const viewer = fakeViewer();
    const { deps } = fakeHarness();
    const layer = createIndianHistoryLayer(deps);
    await layer.init(viewer);
    assert.equal(layer.setParams({ kingdom: 'gupta' }, { origin: 'local-restore' }), true);
    await layer.enable(viewer);
    await layer.update(viewer);
    assert.ok(entityIds(viewer).includes('history:gupta:city:nalanda'));
    assert.equal(viewer._flights.length, 0);
  });
});

test('clicking an event opens its card; clicking the card opens Wikipedia', async () => {
  await withWindow(async () => {
    const viewer = fakeViewer();
    const { deps, overlay, handlers, opened } = fakeHarness();
    const layer = createIndianHistoryLayer(deps);
    await layer.init(viewer);
    await layer.enable(viewer);
    await layer.update(viewer);

    const entity = viewer._sources[0].entities.getById('history:maurya:event:kalinga-war');
    viewer.scene.pick = () => ({ id: entity });
    handlers[0].action({ position: { x: 10, y: 10 } });
    const [card] = overlay.entries.get('indian-history');
    assert.match(card.title, /Kalinga War$/);
    assert.equal(opened.length, 0);

    overlay.hit = { sourceId: 'indian-history', entryId: card.id, entry: card };
    handlers[0].action({ position: { x: 10, y: 10 } });
    assert.deepEqual(opened, ['https://en.wikipedia.org/wiki/Kalinga_War']);

    // The accessible activation path opens the same link.
    assert.equal(card.activate(), true);
    assert.equal(opened.length, 2);

    // Empty space clears the card.
    overlay.hit = null;
    viewer.scene.pick = () => null;
    handlers[0].action({ position: { x: 500, y: 500 } });
    assert.equal(overlay.entries.has('indian-history'), false);
  });
});

test('disable hides and releases the click handler; destroy removes everything', async () => {
  await withWindow(async () => {
    const viewer = fakeViewer();
    const { deps, handlers } = fakeHarness();
    const layer = createIndianHistoryLayer(deps);
    await layer.init(viewer);
    await layer.enable(viewer);
    await layer.update(viewer);

    await layer.disable();
    assert.equal(viewer._sources[0].show, false);
    assert.equal(handlers[0].destroyed, true);

    await layer.destroy(viewer);
    assert.equal(viewer._sources.length, 0);
  });
});

test('a malformed dataset fails update() and reports unavailable', async () => {
  await withWindow(async () => {
    const viewer = fakeViewer();
    const { deps } = fakeHarness();
    const layer = createIndianHistoryLayer({ ...deps, loadData: async () => ({ kingdoms: 'nope' }) });
    await layer.init(viewer);
    await layer.enable(viewer);
    assert.equal(await layer.update(viewer), false);
    assert.equal(layer.getStats().status, 'unavailable');
    assert.match(layer.getStats().meta, /history data unavailable/);
  });
});

test('the card closes via its ✕, a second marker click, or a click on the ground', async () => {
  await withWindow(async () => {
    const viewer = fakeViewer();
    const { deps, overlay, handlers, opened } = fakeHarness();
    const layer = createIndianHistoryLayer(deps);
    await layer.init(viewer);
    await layer.enable(viewer);
    await layer.update(viewer);
    const click = (x, y) => handlers[0].action({ position: { x, y } });
    const entity = viewer._sources[0].entities.getById('history:maurya:city:taxila');
    const open = () => {
      overlay.hit = null;
      viewer.scene.pick = () => ({ id: entity });
      click(10, 10);
      assert.equal(overlay.entries.has('indian-history'), true);
      return overlay.entries.get('indian-history')[0];
    };

    // ✕ in the top-right corner of the card's rect closes without opening a link.
    const card = open();
    assert.equal(card.closable, true);
    overlay.hit = { sourceId: 'indian-history', entryId: card.id, entry: card, rect: { x: 100, y: 100, w: 240, h: 90 } };
    click(100 + 240 - 12, 100 + 12);
    assert.equal(overlay.entries.has('indian-history'), false);
    assert.deepEqual(opened, []);

    // Clicking the same marker again toggles its card closed.
    open();
    click(10, 10);
    assert.equal(overlay.entries.has('indian-history'), false);

    // A 3D-tile / terrain pick (no owning layer) counts as empty ground.
    open();
    viewer.scene.pick = () => ({ primitive: {}, content: {} });
    click(700, 400);
    assert.equal(overlay.entries.has('indian-history'), false);
  });
});
