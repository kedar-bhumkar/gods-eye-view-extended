/**
 * @module data/newsPresentation
 * @description How the News layer decides what to draw and what to say — the
 * decisions, separated from the rendering.
 *
 * Cesium-free on purpose, following the repo's `*Policy` convention: the big
 * modules render, the small ones decide, and the small ones can then be tested
 * without a browser or a 3D engine. This split exists because of a real bug —
 * the viewer is created with `infoBox: false`, so a clicked pin's
 * `entity.description` rendered nowhere, and nothing in a unit test could have
 * caught it while the card-building logic lived inside a Cesium import.
 */

import { impactBand } from './newsPolicy.js';

/** Source id this layer publishes world-overlay entries under. */
export const NEWS_OVERLAY_SOURCE_ID = 'news';
/** Hard ceiling on pins drawn at once, whatever the day holds. */
export const MAX_PINS = 400;

/**
 * Choose the impact floor for a day, so a loud day stays legible.
 *
 * Measured against a real India day: 3,841 stories, of which 3,037 ran on a
 * single outlet. Drawing all of them is an unreadable smear that also says
 * something false — that every wire item matters as much as the day's headline.
 * Raising the floor until the count fits keeps the map honest about which
 * stories were actually carried, and `getStats()` reports what was held back.
 * @param {Array<{impact:number}>} rows Candidate rows, any order.
 * @param {number} [budget] Maximum pins to draw.
 * @returns {{floor:number, shown:number, hidden:number}} The chosen floor.
 */
export function chooseImpactFloor(rows, budget = MAX_PINS) {
  const list = Array.isArray(rows) ? rows : [];
  const cap = Math.max(1, Math.floor(Number(budget) || MAX_PINS));
  const counts = [0, 0, 0, 0, 0, 0];
  for (const row of list) {
    const impact = Math.min(5, Math.max(1, Math.round(Number(row?.impact) || 1)));
    counts[impact]++;
  }
  let running = 0;
  for (let floor = 5; floor >= 1; floor--) {
    const next = running + counts[floor];
    if (next > cap) {
      return { floor: floor + 1, shown: running, hidden: list.length - running };
    }
    running = next;
  }
  return { floor: 1, shown: list.length, hidden: 0 };
}

/** Human summary for the toggle row's meta line. */
export function describeNewsState({ country, day, shown, hidden, unavailable }) {
  if (unavailable) return 'news database unavailable — run scripts/news-ingest.mjs';
  if (!country) return 'fly over a country to see its news';
  if (!shown) return `${country} · ${day} · nothing ingested for this day`;
  const held = hidden > 0 ? ` · ${hidden} lower-impact hidden` : '';
  return `${country} · ${day} · ${shown} pinned${held}`;
}

/**
 * The card shown for the pin the operator clicked.
 *
 * The viewer is created with `infoBox: false` (main.js), so `entity.description`
 * renders nowhere — the app has its own surfaces. Layers publish through the
 * world overlay, and a clicked feature is a `card` marked selected/protected
 * so the collision arbiter cannot drop the one thing the operator asked for.
 * @param {object} row Placed news row.
 * @param {Cesium.Cartesian3} position Pin anchor.
 * @returns {object} World-overlay entry.
 */
export function createNewsCardEntry(row, position) {
  const band = impactBand(row.impact);
  const outlets = Number(row.distinctDomains) || 1;
  const when = String(row.publishedAt || '').slice(11, 16);
  return {
    id: `selected:${row.id}`,
    source: NEWS_OVERLAY_SOURCE_ID,
    position,
    variant: 'card',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    zIndex: 40,
    title: row.title,
    details: [
      `${band.label} · ${outlets} outlet${outlets === 1 ? '' : 's'}`,
      `${row.source}${when ? ` · ${when} UTC` : ''}`,
      'scattered within country, not the event location',
    ],
    accent: band.color,
    interactive: false,
    verticalOnly: true,
    placement: 'above',
    gapPx: 14,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
  };
}
