/**
 * Minnesota DOT (511mn.org) camera pack. Fork addition; moved here from the
 * pre-split vite.config.js unchanged apart from imports.
 */
import { directionToHeading } from '../../../src/data/directionText.js';
import { CCTV_SOURCE_FETCH_TIMEOUT_MS } from './constants.js';
import { fallbackHeadingFromId, prioritizeSources } from './normalize.js';

/**
 * Minnesota DOT cameras (511mn.org). No public API is published for this
 * site — these two queries were reverse-engineered from its own bundled JS
 * (2026-09-09) by capturing what the site's own camera-list and map-pin
 * views send to their internal GraphQL endpoint.
 */
const MNDOT_GRAPHQL_URL = 'https://511mn.org/api/graphql';
/** Bbox-filtered, paginated camera catalog. Titles and image URLs — no coordinates. */
const MNDOT_LIST_QUERY = 'query ($input: ListArgs!) { listCameraViewsQuery(input: $input) '
  + '{ cameraViews { title uri url parentCollection { uri location { routeDesignator } } } '
  + 'totalRecords error { message type } } }';
/**
 * Per-camera coordinate lookup. The list query above carries no lat/lon, so
 * each kept camera needs one of these. The response embeds a server-generated
 * Google Static Maps URL; only its `center=lat,lon` parameter is read — no
 * Google Maps key is used or required on our end, MnDOT's own server already
 * spent one building that URL.
 */
const MNDOT_MODAL_QUERY = 'query ( $entitySlug: String! $entityId: ID! $zooms: [Int!]! '
  + '$xMapDimensionPx: Int! $yMapDimensionPx: Int! $clientBaseUrl: String! ) '
  + '{ listMapModalQuery(entitySlug: $entitySlug, entityId: $entityId) { feature { uri title color icon '
  + 'location { routeDesignator } lastUpdated { timestamp timezone } ... on Camera { views { uri } } '
  + 'staticGoogleImages( zooms: $zooms xMapDimensionPx: $xMapDimensionPx yMapDimensionPx: $yMapDimensionPx '
  + 'clientBaseUrl: $clientBaseUrl ) { staticGoogleImageUrls { url zoom } defaultZoom } } } }';
/** Twin Cities downtown-core bbox — dense enough that one page covers the
 *  metro without statewide pagination (MN has ~1,942 cameras total). */
const DEFAULT_MNDOT_BBOX = {
  west: -93.45, south: 44.85, east: -92.95, north: 45.15,
};
/** Candidates fetched per catalog refresh, BEFORE per-camera geocoding (see
 *  loader JSDoc) — kept modest since, unlike every other pack here, each one
 *  costs its own upstream request. */
const MNDOT_LIST_FETCH_LIMIT = 80;
const DEFAULT_MNDOT_MAX_SOURCES = 60;
/** Bounds the per-camera coordinate-lookup fan-out. */
const MNDOT_MODAL_CONCURRENCY = 10;
const MNDOT_ANCHORS = [
  { lat: 44.9778, lon: -93.2650 }, // Minneapolis
  { lat: 44.9537, lon: -93.0900 }, // St. Paul
];

/**
 * Fetch Minnesota DOT (511mn.org) traffic cameras for the Twin Cities metro.
 *
 * 511mn.org has no published public API; this replays the same internal
 * GraphQL endpoint its own site uses (see MNDOT_LIST_QUERY/MNDOT_MODAL_QUERY
 * JSDoc). Two round trips per camera kept, unlike every other pack here:
 *
 *  1. `listCameraViewsQuery`, bbox-filtered to the Twin Cities core, returns
 *     titles and image URLs but — unlike Austin/Caltrans/TfL — NO coordinates.
 *  2. One `listMapModalQuery` per candidate camera resolves its lat/lon (see
 *     MNDOT_MODAL_QUERY JSDoc for how, without a Google key on our end).
 *
 * Step 2 is fetched in bounded batches (MNDOT_MODAL_CONCURRENCY) since it is
 * one request per camera, not one request per catalog. The candidate list is
 * capped at MNDOT_LIST_FETCH_LIMIT BEFORE that fan-out (not after, like the
 * other packs' distance-prioritization) specifically to bound it; the bbox is
 * drawn tight around the Twin Cities core so an unprioritized first-page cut
 * is already a reasonable "densest core" set. `prioritizeSources` still runs
 * afterward for consistency with every other pack, against real coordinates.
 *
 * Images are served from a second, simple, unauthenticated host —
 * public.carsprogram.org, the multi-state "CARS Program" platform — which is
 * the one part of this integration that behaves like a normal public feed.
 * HLS video sources exist too but this pack is stills-first, matching TfL.
 *
 * @param {object} [deps] Injection seam for tests — real callers omit this.
 * @param {typeof fetch} [deps.fetchImpl] Fetch implementation (defaults to global fetch).
 * @returns {Promise<Array<object>>} Normalized camera source objects.
 */
export async function loadMnDotSourcesFromOpenData({ fetchImpl = fetch } = {}) {
  try {
    const bbox = DEFAULT_MNDOT_BBOX;
    const listResp = await fetchImpl(MNDOT_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        query: MNDOT_LIST_QUERY,
        variables: {
          input: {
            west: bbox.west,
            south: bbox.south,
            east: bbox.east,
            north: bbox.north,
            sortDirection: 'DESC',
            sortType: 'ROADWAY',
            freeSearchTerm: '',
            classificationsOrSlugs: [],
            recordLimit: MNDOT_LIST_FETCH_LIMIT,
            recordOffset: 0,
          },
        },
      }),
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    if (!listResp.ok) {
      console.warn('[CCTV] MnDOT camera list failed:', listResp.status);
      return [];
    }
    const listJson = await listResp.json();
    const views = listJson?.data?.listCameraViewsQuery?.cameraViews;
    if (!Array.isArray(views) || !views.length) return [];

    // One view per physical camera in every observed sample; dedupe by parent
    // defensively in case the catalog ever adds multi-angle cameras.
    const byParent = new Map();
    for (const view of views) {
      const parentUri = String(view?.parentCollection?.uri || '');
      const parentId = parentUri.split('/').pop();
      const imageUrl = String(view?.url || '');
      // Official-host pin (design precedent: Caltrans/TfL do the same for
      // their image origins) — also drops rows with no still image.
      if (!parentId || !imageUrl.startsWith('https://public.carsprogram.org/')) continue;
      if (!byParent.has(parentId)) {
        byParent.set(parentId, {
          parentId,
          title: String(view?.title || '').trim(),
          imageUrl,
        });
      }
    }
    const candidates = Array.from(byParent.values());
    if (!candidates.length) return [];

    // Bounded-concurrency coordinate lookup — see JSDoc. One camera's modal
    // query failing drops just that camera, never the whole pack.
    const resolved = [];
    for (let i = 0; i < candidates.length; i += MNDOT_MODAL_CONCURRENCY) {
      const batch = candidates.slice(i, i + MNDOT_MODAL_CONCURRENCY);
      // eslint-disable-next-line no-await-in-loop
      const settled = await Promise.allSettled(batch.map(async (candidate) => {
        const resp = await fetchImpl(MNDOT_GRAPHQL_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            query: MNDOT_MODAL_QUERY,
            variables: {
              entitySlug: 'camera',
              entityId: candidate.parentId,
              zooms: [13],
              xMapDimensionPx: 400,
              yMapDimensionPx: 300,
              clientBaseUrl: 'https://511mn.org',
            },
          }),
          signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
        });
        if (!resp.ok) throw new Error(`modal HTTP ${resp.status}`);
        const json = await resp.json();
        const urls = json?.data?.listMapModalQuery?.feature?.staticGoogleImages?.staticGoogleImageUrls;
        const url = Array.isArray(urls) ? String(urls[0]?.url || '') : '';
        const match = /center=([-0-9.]+)%2C([-0-9.]+)/.exec(url) || /center=([-0-9.]+),([-0-9.]+)/.exec(url);
        if (!match) throw new Error('no center coordinate in modal response');
        return { ...candidate, lat: Number(match[1]), lon: Number(match[2]) };
      }));
      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') resolved.push(outcome.value);
      }
    }

    const cameras = resolved
      .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon))
      .map((c) => {
        const cameraId = `mn-${c.parentId}`;
        // Free-form title text ("I-694: I-694 EB @ Silver Lake Rd") — only
        // explicit travel forms count (allowBare=false), same policy as
        // Austin's name-inferred fallback heading.
        const heading = directionToHeading(c.title);
        const hasHeading = Number.isFinite(heading);
        return {
          id: cameraId,
          name: c.title || `MnDOT Camera ${c.parentId}`,
          city: 'Twin Cities Metro',
          cityId: 'twin-cities',
          provider: 'Minnesota DOT (511mn.org)',
          lat: c.lat,
          lon: c.lon,
          headingDeg: hasHeading ? heading : fallbackHeadingFromId(cameraId),
          headingConfidence: hasHeading ? 'high' : 'low',
          // Same fabricated pose personalities as Austin/Caltrans (design
          // §1a): RAW PRIOR starting points, not measured truth.
          pitchDeg: hasHeading ? -24 : -18,
          fovDeg: hasHeading ? 56 : 44,
          rangeM: hasHeading ? 210 : 145,
          mountHeightM: hasHeading ? 10 : 8,
          groundElevationM: 260, // Twin Cities metro prior; one-shot snap corrects.
          feedType: 'image',
          url: c.imageUrl,
          snapshotUrl: c.imageUrl,
          sourceKind: 'mndot-511',
          license: 'Public MnDOT traffic camera frame (511mn.org / CARS Program)',
        };
      });

    const maxRaw = Number(process.env.CCTV_MNDOT_MAX_SOURCES || DEFAULT_MNDOT_MAX_SOURCES);
    const maxCount = Number.isFinite(maxRaw) ? Math.max(8, Math.min(200, Math.floor(maxRaw))) : DEFAULT_MNDOT_MAX_SOURCES;
    const prioritized = prioritizeSources(cameras, maxCount, MNDOT_ANCHORS);
    console.log(`[CCTV] Loaded MnDOT camera sources: ${cameras.length} geocoded (using nearest ${prioritized.length})`);
    return prioritized;
  } catch (error) {
    console.warn('[CCTV] MnDOT source download error:', error?.message || error);
    return [];
  }
}

