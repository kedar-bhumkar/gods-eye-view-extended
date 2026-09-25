/**
 * @module newsPlacement
 * @description Where a news pin goes, and which country the camera is over.
 * Pure geometry — no Cesium, no DOM, no `node:` imports — so both halves are
 * unit-testable and the ingester could reuse them unchanged.
 *
 * The load-bearing property is determinism. A pin's position is a function of
 * the article id and nothing else: no `Math.random()`, no clock, no insertion
 * order. Scrub to another day and back, reload the page, open a share link a
 * week later — the same story is in the same place. A pin that wanders reads
 * as a bug even when the data is right.
 */

/** Rings whose combined area falls below this share of the country are ignored
 *  when scattering, so a pin does not land on an uninhabited speck. */
const MIN_RING_AREA_SHARE = 0.001;
/** Rejection-sampling budget per article before falling back to a centroid. */
const MAX_SAMPLE_ATTEMPTS = 64;
/** How far outside every polygon a camera may sit and still resolve to the
 *  nearest country. Covers generalised coastlines (Miami, Venice) and a camera
 *  parked just offshore; beyond it, "no country" is the honest answer. */
export const NEAREST_COUNTRY_MAX_KM = 120;

const KM_PER_DEG_LAT = 110.574;

/**
 * FNV-1a 32-bit hash, matching `newsPolicy.fnv1a32`.
 *
 * Duplicated rather than imported so this module stays standalone geometry —
 * it is the seed source, and the two must never drift, which the tests pin.
 * @param {string} text Input.
 * @returns {number} Unsigned 32-bit hash.
 */
export function hashSeed(text) {
  let hash = 0x811c9dc5;
  const input = String(text ?? '');
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * mulberry32 — a small, fast, well-distributed seeded PRNG.
 * @param {number} seed Unsigned 32-bit seed.
 * @returns {() => number} Generator yielding [0, 1).
 */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Even-odd point-in-ring test on a `[[lon, lat], …]` ring.
 * @param {Array<[number, number]>} ring Closed or open ring.
 * @param {number} lat Latitude in degrees.
 * @param {number} lon Longitude in degrees.
 * @returns {boolean} True when the point is inside.
 */
export function pointInRing(ring, lat, lon) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/** Whether a point falls inside any of a country's rings. */
export function pointInCountry(country, lat, lon) {
  if (!country?.rings?.length) return false;
  const [west, south, east, north] = country.bbox || [-180, -90, 180, 90];
  if (lon < west || lon > east || lat < south || lat > north) return false;
  return country.rings.some((ring) => pointInRing(ring, lat, lon));
}

/** Great-circle-ish distance in km. Equirectangular — accurate enough well under 1000 km. */
function approxKm(latA, lonA, latB, lonB) {
  const meanLat = ((latA + latB) / 2) * (Math.PI / 180);
  const dx = (lonB - lonA) * 111.320 * Math.cos(meanLat);
  const dy = (latB - latA) * KM_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/**
 * Shortest distance in km from a point to a ring's EDGES.
 *
 * Edges, not vertices. Distance to the nearest vertex is a wildly different
 * number on any polygon with long straight edges — a point 30 km off a coast
 * whose nearest two vertices are 500 km apart measures as ~250 km away and the
 * nearest-country fallback silently declines it, or picks a different country.
 * Real coastlines are dense enough to hide this; a simplified border is not.
 *
 * Distances are computed in a local planar projection around the query point,
 * which is accurate well inside the fallback radius.
 * @param {Array<[number, number]>} ring Ring vertices.
 * @param {number} lat Latitude in degrees.
 * @param {number} lon Longitude in degrees.
 * @returns {number} Kilometres to the closest point on the ring.
 */
function distanceToRingKm(ring, lat, lon) {
  if (!Array.isArray(ring) || ring.length < 2) return Infinity;
  const kmPerDegLon = 111.320 * Math.cos((lat * Math.PI) / 180);
  const toLocal = ([pointLon, pointLat]) => [
    (pointLon - lon) * kmPerDegLon,
    (pointLat - lat) * KM_PER_DEG_LAT,
  ];

  let best = Infinity;
  let previous = toLocal(ring[ring.length - 1]);
  for (const vertex of ring) {
    const current = toLocal(vertex);
    const dx = current[0] - previous[0];
    const dy = current[1] - previous[1];
    const lengthSquared = (dx * dx) + (dy * dy);
    let closestX = previous[0];
    let closestY = previous[1];
    if (lengthSquared > 0) {
      // Projection of the origin (the query point) onto this segment.
      const t = Math.max(0, Math.min(1, -((previous[0] * dx) + (previous[1] * dy)) / lengthSquared));
      closestX = previous[0] + t * dx;
      closestY = previous[1] + t * dy;
    }
    const distance = Math.hypot(closestX, closestY);
    if (distance < best) best = distance;
    previous = current;
  }
  return best;
}

/**
 * Which country is the camera over?
 *
 * Containment first; when nothing contains the point, the nearest country
 * within {@link NEAREST_COUNTRY_MAX_KM}. The fallback is not a nicety: even at
 * 1:10m, Miami and Venice sit outside their own generalised coastlines, and a
 * camera over a harbour or just offshore should still read as that country
 * rather than blanking the layer.
 * @param {Array<object>} countries Loaded country records.
 * @param {number} lat Latitude in degrees.
 * @param {number} lon Longitude in degrees.
 * @param {object} [options] Tuning.
 * @param {number} [options.maxKm] Fallback radius.
 * @returns {{iso: string, name: string, exact: boolean, distanceKm: number}|null} Match, or null.
 */
export function countryAt(countries, lat, lon, { maxKm = NEAREST_COUNTRY_MAX_KM } = {}) {
  if (!Array.isArray(countries) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  for (const country of countries) {
    if (pointInCountry(country, lat, lon)) {
      return { iso: country.iso, name: country.name, exact: true, distanceKm: 0 };
    }
  }

  let best = null;
  const padDeg = maxKm / KM_PER_DEG_LAT;
  for (const country of countries) {
    const [west, south, east, north] = country.bbox || [];
    // Cheap bbox reject before walking thousands of vertices.
    if (!Number.isFinite(west)
      || lon < west - padDeg || lon > east + padDeg
      || lat < south - padDeg || lat > north + padDeg) continue;
    for (const ring of country.rings) {
      const distance = distanceToRingKm(ring, lat, lon);
      if (distance <= maxKm && (!best || distance < best.distanceKm)) {
        best = { iso: country.iso, name: country.name, exact: false, distanceKm: distance };
      }
    }
  }
  return best;
}

/**
 * Choose one of a country's rings, weighted by area, using the seeded PRNG.
 *
 * Area weighting is what stops every Indonesian pin landing on whichever island
 * happens to be first in the file: a country's pins spread across its landmass
 * in proportion to how much land each part actually is.
 * @param {object} country Country record with `rings` and `areas`.
 * @param {() => number} random Seeded generator.
 * @returns {{ring: Array<[number, number]>, index: number}|null} Chosen ring.
 */
export function pickRingByArea(country, random) {
  const rings = country?.rings;
  if (!Array.isArray(rings) || !rings.length) return null;
  const areas = Array.isArray(country.areas) && country.areas.length === rings.length
    ? country.areas.map((value) => Math.max(0, Number(value) || 0))
    : rings.map(() => 1);
  const total = areas.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return { ring: rings[0], index: 0 };

  const floor = total * MIN_RING_AREA_SHARE;
  const eligible = [];
  let eligibleTotal = 0;
  for (let i = 0; i < rings.length; i++) {
    if (areas[i] < floor) continue;
    eligible.push({ index: i, area: areas[i] });
    eligibleTotal += areas[i];
  }
  if (!eligible.length) return { ring: rings[0], index: 0 };

  let target = random() * eligibleTotal;
  for (const entry of eligible) {
    target -= entry.area;
    if (target <= 0) return { ring: rings[entry.index], index: entry.index };
  }
  const last = eligible.at(-1);
  return { ring: rings[last.index], index: last.index };
}

/** Axis-aligned bounds of a ring. */
function ringBounds(ring) {
  let west = Infinity; let south = Infinity; let east = -Infinity; let north = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return { west, south, east, north };
}

/** Vertex-average of a ring — always inside for convex shapes, near-centre otherwise. */
function ringCentroid(ring) {
  let lonSum = 0; let latSum = 0;
  for (const [lon, lat] of ring) { lonSum += lon; latSum += lat; }
  return { lat: latSum / ring.length, lon: lonSum / ring.length };
}

/**
 * Deterministic position for one article inside its country.
 *
 * Real coordinates win when the row has them — the schema carries nullable
 * `lat`/`lon` precisely so that the day the ingester learns to geocode, the map
 * improves with no change here. Otherwise: seed a PRNG from the article id,
 * pick a ring by area, and reject-sample inside it.
 *
 * The sampling budget is bounded because long thin countries (Chile, Norway,
 * Indonesia) have bounding boxes mostly full of sea, so a naive loop could spin
 * a long time. On exhaustion the pin takes the chosen ring's centroid: a pin
 * always exists, and is never silently dropped.
 * @param {object} article Row with `id`, and optionally `lat`/`lon`.
 * @param {object} country Country record with `rings`, `areas`, `bbox`.
 * @param {object} [options] Tuning.
 * @param {number} [options.maxAttempts] Rejection-sampling budget.
 * @returns {{lat: number, lon: number, source: 'record'|'scatter'|'centroid'}|null} Position.
 */
export function placeArticle(article, country, { maxAttempts = MAX_SAMPLE_ATTEMPTS } = {}) {
  const lat = Number(article?.lat);
  const lon = Number(article?.lon);
  if (Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0)) {
    return { lat, lon, source: 'record' };
  }

  const id = String(article?.id ?? '');
  if (!id || !country?.rings?.length) return null;

  const random = mulberry32(hashSeed(id));
  const picked = pickRingByArea(country, random);
  if (!picked) return null;

  const bounds = ringBounds(picked.ring);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const sampleLon = bounds.west + random() * (bounds.east - bounds.west);
    const sampleLat = bounds.south + random() * (bounds.north - bounds.south);
    if (pointInRing(picked.ring, sampleLat, sampleLon)) {
      return { lat: sampleLat, lon: sampleLon, source: 'scatter' };
    }
  }

  const centroid = ringCentroid(picked.ring);
  return { lat: centroid.lat, lon: centroid.lon, source: 'centroid' };
}

/**
 * Place a whole day's articles, reporting how each position was arrived at so
 * the layer can be honest in its meta line about what the pins mean.
 * @param {Array<object>} articles Rows.
 * @param {object} country Country record.
 * @returns {{placed: Array<object>, counts: {record: number, scatter: number, centroid: number, failed: number}}} Result.
 */
export function placeArticles(articles, country) {
  const counts = { record: 0, scatter: 0, centroid: 0, failed: 0 };
  const placed = [];
  for (const article of Array.isArray(articles) ? articles : []) {
    const position = placeArticle(article, country);
    if (!position) { counts.failed++; continue; }
    counts[position.source]++;
    placed.push({ ...article, ...position });
  }
  return { placed, counts };
}
