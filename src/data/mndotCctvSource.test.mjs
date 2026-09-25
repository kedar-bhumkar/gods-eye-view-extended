import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMnDotSourcesFromOpenData } from '../../vite.config.js';

/**
 * Builds a fetchImpl that answers the two MnDOT GraphQL queries this loader
 * sends, keyed by which one a request body contains — mirroring the shape
 * of the real (reverse-engineered) 511mn.org API without hitting the network.
 */
function mockMnDotFetch({ listViews, modalByEntityId, failList = false, failEntityIds = [] } = {}) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    if (failList && body.query.includes('listCameraViewsQuery')) {
      return { ok: false, status: 503 };
    }
    if (body.query.includes('listCameraViewsQuery')) {
      return {
        ok: true,
        json: async () => ({
          data: { listCameraViewsQuery: { cameraViews: listViews, totalRecords: listViews.length, error: null } },
        }),
      };
    }
    if (body.query.includes('listMapModalQuery')) {
      const entityId = body.variables.entityId;
      if (failEntityIds.includes(entityId)) {
        return { ok: false, status: 500 };
      }
      const center = modalByEntityId[entityId];
      const urls = center
        ? [{ url: `https://maps.googleapis.com/x?center=${center.lat}%2C${center.lon}&zoom=13`, zoom: 13 }]
        : [{ url: 'https://maps.googleapis.com/x?zoom=13', zoom: 13 }]; // no center param
      return {
        ok: true,
        json: async () => ({ data: { listMapModalQuery: { feature: { staticGoogleImages: { staticGoogleImageUrls: urls } } } } }),
      };
    }
    throw new Error(`unexpected query in test: ${body.query.slice(0, 80)}`);
  };
}

function view(parentId, title, { imageUrl } = {}) {
  return {
    title,
    uri: `camera/${parentId}/1`,
    url: imageUrl ?? `https://public.carsprogram.org/cameras/MN/C${parentId}`,
    parentCollection: { uri: `camera/${parentId}`, location: { routeDesignator: 'I-694' } },
  };
}

test('MnDOT loader normalizes, geocodes, and infers heading from free-form titles', async () => {
  const fetchImpl = mockMnDotFetch({
    listViews: [view('500638', 'I-694: I-694 EB @ Silver Lake Rd')],
    modalByEntityId: { 500638: { lat: 45.0644, lon: -93.2186 } },
  });
  const cameras = await loadMnDotSourcesFromOpenData({ fetchImpl });

  assert.equal(cameras.length, 1);
  const cam = cameras[0];
  assert.equal(cam.id, 'mn-500638');
  assert.equal(cam.name, 'I-694: I-694 EB @ Silver Lake Rd');
  assert.equal(cam.lat, 45.0644);
  assert.equal(cam.lon, -93.2186);
  assert.equal(cam.headingDeg, 90); // EB → east
  assert.equal(cam.headingConfidence, 'high');
  assert.equal(cam.sourceKind, 'mndot-511');
  assert.equal(cam.url, 'https://public.carsprogram.org/cameras/MN/C500638');
  assert.equal(cam.feedType, 'image');
});

test('a camera with no recognizable direction falls back to a low-confidence hashed heading', async () => {
  const fetchImpl = mockMnDotFetch({
    listViews: [view('999', 'TH 10 @ County Rd 9')],
    modalByEntityId: { 999: { lat: 45.1, lon: -93.3 } },
  });
  const [cam] = await loadMnDotSourcesFromOpenData({ fetchImpl });
  assert.equal(cam.headingConfidence, 'low');
  assert.ok(Number.isFinite(cam.headingDeg));
});

test('cameras are deduplicated by parent camera id', async () => {
  const fetchImpl = mockMnDotFetch({
    listViews: [view('500638', 'I-694 EB view A'), view('500638', 'I-694 EB view B')],
    modalByEntityId: { 500638: { lat: 45.0644, lon: -93.2186 } },
  });
  const cameras = await loadMnDotSourcesFromOpenData({ fetchImpl });
  assert.equal(cameras.length, 1);
});

test('an image URL off the official carsprogram.org host is dropped', async () => {
  const fetchImpl = mockMnDotFetch({
    listViews: [view('1', 'I-94 WB', { imageUrl: 'https://evil.example.com/cam.jpg' })],
    modalByEntityId: { 1: { lat: 45, lon: -93 } },
  });
  const cameras = await loadMnDotSourcesFromOpenData({ fetchImpl });
  assert.equal(cameras.length, 0);
});

test('a camera whose modal query has no parseable center coordinate is dropped, not crashed', async () => {
  const fetchImpl = mockMnDotFetch({
    listViews: [view('1', 'I-94 WB'), view('2', 'I-94 EB')],
    modalByEntityId: { 2: { lat: 45, lon: -93 } }, // camera 1 has no center in its mock response
  });
  const cameras = await loadMnDotSourcesFromOpenData({ fetchImpl });
  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].id, 'mn-2');
});

test('one camera failing its coordinate lookup does not drop the rest', async () => {
  const fetchImpl = mockMnDotFetch({
    listViews: [view('1', 'I-94 WB'), view('2', 'I-94 EB')],
    modalByEntityId: { 1: { lat: 45, lon: -93 }, 2: { lat: 45.01, lon: -93.01 } },
    failEntityIds: ['1'],
  });
  const cameras = await loadMnDotSourcesFromOpenData({ fetchImpl });
  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].id, 'mn-2');
});

test('a failing camera list query degrades to an empty pack rather than throwing', async () => {
  const fetchImpl = mockMnDotFetch({ listViews: [], modalByEntityId: {}, failList: true });
  const cameras = await loadMnDotSourcesFromOpenData({ fetchImpl });
  assert.deepEqual(cameras, []);
});

test('an empty camera list resolves to an empty pack', async () => {
  const fetchImpl = mockMnDotFetch({ listViews: [], modalByEntityId: {} });
  const cameras = await loadMnDotSourcesFromOpenData({ fetchImpl });
  assert.deepEqual(cameras, []);
});

test('a fetch implementation that throws is caught and degrades to an empty pack', async () => {
  const cameras = await loadMnDotSourcesFromOpenData({
    fetchImpl: async () => { throw new Error('network down'); },
  });
  assert.deepEqual(cameras, []);
});

test('the final catalog is capped (an 8-camera floor, like every other pack) and distance-prioritized toward the Twin Cities anchors', async () => {
  // Minneapolis anchor is ~44.9778,-93.2650. One near camera plus eight far
  // ones — an aggressive env override still can't push the cap below 8
  // (prioritizeSources' floor, shared with Austin/Caltrans/TfL), so this
  // also pins that floor while proving the near camera always survives.
  const listViews = [view('near', 'I-94 EB')];
  const modalByEntityId = { near: { lat: 44.98, lon: -93.27 } }; // a few km from downtown Minneapolis
  for (let i = 0; i < 8; i++) {
    listViews.push(view(`far${i}`, 'I-94 EB'));
    modalByEntityId[`far${i}`] = { lat: 48.0, lon: -97.0 - i }; // far northwest Minnesota
  }
  const fetchImpl = mockMnDotFetch({ listViews, modalByEntityId });
  const previousEnv = process.env.CCTV_MNDOT_MAX_SOURCES;
  process.env.CCTV_MNDOT_MAX_SOURCES = '1';
  try {
    const cameras = await loadMnDotSourcesFromOpenData({ fetchImpl });
    assert.equal(cameras.length, 8, 'the 8-camera floor applies even to an aggressive override');
    assert.ok(cameras.some((c) => c.id === 'mn-near'), 'the nearest camera always survives the cut');
  } finally {
    if (previousEnv === undefined) delete process.env.CCTV_MNDOT_MAX_SOURCES;
    else process.env.CCTV_MNDOT_MAX_SOURCES = previousEnv;
  }
});
