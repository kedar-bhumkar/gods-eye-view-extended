#!/usr/bin/env node
/**
 * Build src/data/local_data/natural_earth/countries.json from Natural Earth's
 * public-domain 1:10m admin-0 country boundaries.
 *
 * Why this file has to exist: the repo already bundles Natural Earth *physical*
 * regions (islands, deserts, peninsulas) in `regions.json`, but nothing in the
 * tree carries country boundaries. The News layer needs them twice — to decide
 * which country the camera is over, and to scatter a country's pins inside its
 * own outline — and doing both offline keeps the layer keyless.
 *
 * Source:   https://github.com/nvkelso/natural-earth-vector
 *           geojson/ne_10m_admin_0_countries.geojson
 * License:  Public domain (Natural Earth — naturalearthdata.com)
 *
 * 10m rather than 50m, measured rather than assumed. Point-in-polygon against
 * 14 real city coordinates: 50m placed 7 of them inside their own country —
 * New York, Miami, Kochi, Hong Kong and San Francisco all fell in the sea,
 * because at 1:50,000,000 the coastline is generalised past those harbours.
 * 10m gets 12 of 14 for 2.95 MB instead of 1.16 MB, and the file is lazily
 * loaded, so it costs nothing until someone turns the News layer on. Miami and
 * Venice still miss; the nearest-country fallback in newsPlacement.js covers
 * that, and has to exist anyway for a camera parked over water.
 *
 * Simplification is deliberately gentle: at 1:10m the source vertices are
 * already sparser than a 0.01-degree tolerance in most places, so Douglas-
 * Peucker mostly earns its keep on the few very dense coastlines.
 *
 * Transform (deterministic — same input always gives the same bytes):
 *   1. ISO 3166-1 alpha-2 from ISO_A2_EH, falling back to ISO_A2; features
 *      without a real code (Natural Earth writes -99) are dropped.
 *   2. Outer rings only — holes are discarded, matching regions.json's curation.
 *   3. Douglas-Peucker per ring, tolerance 0.01 degrees (~1.1 km).
 *   4. Coordinates rounded to 3 decimals; consecutive duplicates dropped;
 *      rings re-closed; rings collapsing below 4 points dropped.
 *   5. Parts smaller than 20 km2 dropped (specks that would never hold a pin).
 *   6. Countries sorted by ISO code, rings sorted largest-area first, for a
 *      stable diff.
 *
 * Usage:
 *   node scripts/build-country-polygons.mjs [raw.geojson]
 * With no argument it downloads the live dataset; with an argument it reads the
 * given raw GeoJSON file.
 *
 * @module scripts/build-country-polygons
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_REPO = 'https://github.com/nvkelso/natural-earth-vector';
const SOURCE_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)),
  '..', 'src', 'data', 'local_data', 'natural_earth', 'countries.json');
const TOLERANCE = 0.01; // degrees, ~1.1 km
const DECIMALS = 3;
const MIN_PART_KM2 = 20;

/** Perpendicular distance from point p to segment a-b, in degrees (planar — fine at this tolerance). */
function segDist(p, a, b) {
  let [x, y] = p; const [x1, y1] = a; const [x2, y2] = b;
  const dx = x2 - x1; const dy = y2 - y1;
  if (dx !== 0 || dy !== 0) {
    const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x -= x2; y -= y2; return Math.hypot(x, y); }
    if (t > 0) { x -= x1 + dx * t; y -= y1 + dy * t; return Math.hypot(x, y); }
  }
  return Math.hypot(x - x1, y - y1);
}

/** Iterative Douglas-Peucker on an open point list. */
function douglasPeucker(points, tolerance) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist = 0; let index = -1;
    for (let i = first + 1; i < last; i++) {
      const distance = segDist(points[i], points[first], points[last]);
      if (distance > maxDist) { maxDist = distance; index = i; }
    }
    if (index !== -1 && maxDist > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Approximate ring area in km2. Shoelace in degrees, scaled by the cosine of
 * the ring's mean latitude — accurate enough to rank parts and to weight the
 * random pick, which is all it is used for.
 */
function ringAreaKm2(ring) {
  let twiceArea = 0;
  let latSum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    twiceArea += (ring[j][0] * ring[i][1]) - (ring[i][0] * ring[j][1]);
    latSum += ring[i][1];
  }
  const meanLat = latSum / ring.length;
  const kmPerDegLat = 110.574;
  const kmPerDegLon = 111.320 * Math.cos((meanLat * Math.PI) / 180);
  return Math.abs(twiceArea / 2) * kmPerDegLat * kmPerDegLon;
}

/** Round, drop consecutive duplicates, re-close. */
function cleanRing(ring) {
  const factor = 10 ** DECIMALS;
  const round = (value) => Math.round(value * factor) / factor;
  const out = [];
  for (const [lon, lat] of ring) {
    const point = [round(lon), round(lat)];
    const previous = out.at(-1);
    if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) out.push(point);
  }
  if (out.length > 1) {
    const first = out[0]; const last = out.at(-1);
    if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]]);
  }
  return out;
}

/** Outer rings of a Polygon or MultiPolygon geometry. */
function outerRings(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates.slice(0, 1);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.map((part) => part[0]).filter(Boolean);
  return [];
}

function bboxOf(rings) {
  let west = Infinity; let south = Infinity; let east = -Infinity; let north = -Infinity;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  }
  return [west, south, east, north];
}

async function main() {
  const localPath = process.argv[2];
  let raw;
  if (localPath) {
    raw = JSON.parse(fs.readFileSync(path.resolve(localPath), 'utf8'));
    process.stderr.write(`[countries] read ${localPath}\n`);
  } else {
    process.stderr.write(`[countries] downloading ${SOURCE_URL}\n`);
    const response = await fetch(SOURCE_URL);
    if (!response.ok) throw new Error(`Natural Earth download failed: HTTP ${response.status}`);
    raw = await response.json();
  }

  const countries = [];
  let droppedNoIso = 0;
  let droppedParts = 0;

  for (const feature of raw.features || []) {
    const properties = feature.properties || {};
    const iso = String(properties.ISO_A2_EH ?? properties.ISO_A2 ?? '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(iso)) { droppedNoIso++; continue; }

    const rings = [];
    for (const ring of outerRings(feature.geometry)) {
      const simplified = cleanRing(douglasPeucker(ring, TOLERANCE));
      if (simplified.length < 4) { droppedParts++; continue; }
      const area = ringAreaKm2(simplified);
      if (area < MIN_PART_KM2) { droppedParts++; continue; }
      rings.push({ ring: simplified, area });
    }
    if (!rings.length) continue;

    rings.sort((a, b) => b.area - a.area);
    const ringGeometry = rings.map((entry) => entry.ring);
    countries.push({
      iso,
      name: String(properties.NAME || properties.ADMIN || iso),
      bbox: bboxOf(ringGeometry),
      areas: rings.map((entry) => Math.round(entry.area)),
      rings: ringGeometry,
    });
  }

  countries.sort((a, b) => a.iso.localeCompare(b.iso));

  const payload = {
    meta: {
      source: 'Natural Earth 1:10m cultural vectors — ne_10m_admin_0_countries',
      repository: SOURCE_REPO,
      url: SOURCE_URL,
      license: 'Public domain (Natural Earth — naturalearthdata.com)',
      fetched: new Date().toISOString(),
      curation: {
        toleranceDeg: TOLERANCE,
        coordDecimals: DECIMALS,
        minPartKm2: MIN_PART_KM2,
        outerRingsOnly: true,
        isoField: 'ISO_A2_EH, falling back to ISO_A2',
      },
      countryCount: countries.length,
    },
    countries,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(payload)}\n`, 'utf8');
  const bytes = fs.statSync(OUT).size;
  process.stderr.write(
    `[countries] wrote ${countries.length} countries, `
    + `${countries.reduce((sum, c) => sum + c.rings.length, 0)} rings, `
    + `${(bytes / 1024 / 1024).toFixed(2)} MB -> ${OUT}\n`,
  );
  process.stderr.write(`[countries] dropped ${droppedNoIso} features with no ISO code, ${droppedParts} tiny/degenerate parts\n`);
}

await main();
