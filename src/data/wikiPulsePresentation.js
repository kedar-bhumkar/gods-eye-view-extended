/**
 * @module data/wikiPulsePresentation
 * @description How the Wiki Pulse layer decides what to draw and what to say —
 * separated from rendering, following the repo's `*Presentation`/`*Policy`
 * convention (see `newsPresentation.js`) so it stays testable without Cesium.
 *
 * Two things this module exists to get right, both privacy-adjacent:
 *
 *  - `redactUser` is the one and only place a Wikimedia `user` field is
 *    allowed to become display text. Anonymous edits carry the editor's real
 *    IP address in that field — MediaWiki forbids registered usernames that
 *    look like an IP address specifically so anonymous edits are
 *    distinguishable, which is what makes the heuristic here reliable rather
 *    than a guess. `vite.config.js`'s proxy calls this before an event ever
 *    leaves the server; the layer calls it again on the way to the entity, so
 *    a raw IP cannot reach the globe through either path alone.
 *  - `createWikiPulseCardEntry` never lets a blip's position pass as real —
 *    see `wikiPulsePlacement.js` for why it can't be.
 */

/** Source id this layer publishes world-overlay entries under. */
export const WIKI_PULSE_OVERLAY_SOURCE_ID = 'wiki-pulse';

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;

/**
 * Replace an editor field with "Anonymous editor" when it is an IP address.
 * Never returns the input unmodified when the input looks like an IP —
 * callers must not fall back to the raw value on any other branch.
 * @param {string|null|undefined} user Raw Wikimedia `user` field.
 * @returns {string} Display-safe editor label.
 */
export function redactUser(user) {
  const value = String(user ?? '').trim();
  if (!value) return 'Anonymous editor';
  if (IPV4_RE.test(value)) return 'Anonymous editor';
  if (value.includes(':') && value.split(':').length > 2 && IPV6_RE.test(value)) return 'Anonymous editor';
  return value;
}

const HUMAN_COLOR = '#4FC3D9';
const BOT_COLOR = '#5A6B73';

/**
 * Dot styling for one event: bots read as small and dim, human edits as
 * brighter and a little larger, both nudged by how much text changed.
 * @param {{bot?: boolean, byteDelta?: number|null}} event Placed or unplaced row.
 * @returns {{color: string, dotPx: number, isBot: boolean}}
 */
export function classifyEdit(event) {
  const isBot = Boolean(event?.bot);
  const bytes = Math.min(2000, Math.abs(Number(event?.byteDelta) || 0));
  const scale = bytes / 2000;
  const dotPx = Math.round((isBot ? 5 : 6) + scale * (isBot ? 3 : 6));
  return { color: isBot ? BOT_COLOR : HUMAN_COLOR, dotPx, isBot };
}

/** Human summary for the toggle row's meta line. */
export function describeWikiPulseState({
  count = 0, ratePerMin = 0, humanPct = null, status = 'idle',
} = {}) {
  if (status === 'idle' || status === 'connecting') return 'connecting to Wikimedia EventStreams…';
  if (status === 'degraded' && !count) return 'reconnecting to Wikimedia EventStreams…';
  if (!count) return 'no edits observed yet';
  const human = humanPct == null ? '' : ` · ${Math.round(humanPct)}% human`;
  const degraded = status === 'degraded' ? ' · reconnecting' : '';
  return `${count} edits on screen · ~${Math.round(ratePerMin)}/min${human}${degraded}`;
}

/**
 * The card shown for the blip the operator clicked.
 *
 * Same reason as News: the viewer is created with `infoBox: false`, so
 * `entity.description` renders nowhere, and a clicked feature must publish
 * through the world overlay as a `card` in the protected `selected` lane.
 * @param {object} row Placed, already-redacted Wiki Pulse row.
 * @param {Cesium.Cartesian3} position Blip anchor.
 * @returns {object} World-overlay entry.
 */
export function createWikiPulseCardEntry(row, position) {
  const { color, isBot } = classifyEdit(row);
  const bytes = Number(row.byteDelta);
  const byteText = Number.isFinite(bytes) ? `${bytes >= 0 ? '+' : ''}${bytes} bytes` : 'size unknown';
  const when = row.timestampMs ? new Date(row.timestampMs).toISOString().slice(11, 16) : '';
  const editor = redactUser(row.user);
  return {
    id: `selected:${row.id}`,
    source: WIKI_PULSE_OVERLAY_SOURCE_ID,
    position,
    variant: 'card',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    zIndex: 40,
    title: row.title || '(untitled page)',
    details: [
      `${isBot ? 'Bot edit' : 'Human edit'} · ${byteText}`,
      `${row.wiki || 'wikipedia.org'} · ${editor}${when ? ` · ${when} UTC` : ''}`,
      "Position is illustrative — unrelated to the edit's real location.",
    ],
    accent: color,
    interactive: false,
    verticalOnly: true,
    placement: 'above',
    gapPx: 14,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
  };
}
