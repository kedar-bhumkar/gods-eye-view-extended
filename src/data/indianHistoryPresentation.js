/**
 * @module data/indianHistoryPresentation
 * @description Pure helpers for the Indian History layer: dataset validation,
 * year formatting, label stacking, row status text, and world-overlay card
 * entries. Kept free of Cesium entities so it is testable in plain Node.
 */

export const INDIAN_HISTORY_LAYER_ID = 'indian-history';
export const INDIAN_HISTORY_OVERLAY_SOURCE_ID = 'indian-history';

/**
 * Eras group the row chips so ~50 rulers stay browsable: the row shows the
 * era chips, then only the chips of the open era.
 */
export const HISTORY_ERAS = Object.freeze([
  Object.freeze({ id: 'ancient', label: 'ANCIENT', span: 'to c. 250 CE' }),
  Object.freeze({ id: 'classical', label: 'CLASSICAL', span: 'c. 250–700 CE' }),
  Object.freeze({ id: 'early-medieval', label: 'EARLY MEDIEVAL', span: 'c. 700–1200 CE' }),
  Object.freeze({ id: 'late-medieval', label: 'LATE MEDIEVAL', span: 'c. 1200–1526 CE' }),
  Object.freeze({ id: 'early-modern', label: 'EARLY MODERN', span: '1498–1947 CE' }),
]);

/**
 * Every selectable ruler, in the dataset's chronological order. `code` is its
 * share-link token (layerState.js builds the `kingdom` enum from this list),
 * so codes must stay stable once shipped: add new entries with new codes,
 * never reassign one. The dataset must contain exactly these ids, in this
 * order — pinned by indianHistoryPresentation.test.mjs.
 */
export const KINGDOM_CHIPS = Object.freeze([
  { id: 'nanda', label: 'NANDA', code: 'n', era: 'ancient' },
  { id: 'maurya', label: 'MAURYA', code: 'm', era: 'ancient' },
  { id: 'pandya', label: 'PANDYA', code: 'p', era: 'ancient' },
  { id: 'indo-greek', label: 'INDO-GREEK', code: 'ig', era: 'ancient' },
  { id: 'satavahana', label: 'SATAVAHANA', code: 's', era: 'ancient' },
  { id: 'kushan', label: 'KUSHAN', code: 'ku', era: 'ancient' },
  { id: 'western-satraps', label: 'WESTERN SATRAPS', code: 'ws', era: 'ancient' },
  { id: 'vakataka', label: 'VAKATAKA', code: 'v', era: 'classical' },
  { id: 'pallava', label: 'PALLAVA', code: 'l', era: 'classical' },
  { id: 'gupta', label: 'GUPTA', code: 'g', era: 'classical' },
  { id: 'alchon', label: 'ALCHON HUNS', code: 'ah', era: 'classical' },
  { id: 'chalukya', label: 'CHALUKYA', code: 'c', era: 'classical' },
  { id: 'harsha', label: 'HARSHA', code: 'h', era: 'classical' },
  { id: 'karkota', label: 'KARKOTA', code: 'k', era: 'classical' },
  { id: 'arab-sindh', label: 'ARAB SINDH', code: 'as', era: 'early-medieval' },
  { id: 'pratihara', label: 'PRATIHARA', code: 'r', era: 'early-medieval' },
  { id: 'pala', label: 'PALA', code: 'a', era: 'early-medieval' },
  { id: 'rashtrakuta', label: 'RASHTRAKUTA', code: 't', era: 'early-medieval' },
  { id: 'paramara', label: 'PARAMARA · BHOJA', code: 'b', era: 'early-medieval' },
  { id: 'hindu-shahi', label: 'HINDU SHAHI', code: 'i', era: 'early-medieval' },
  { id: 'chola', label: 'CHOLA', code: 'o', era: 'early-medieval' },
  { id: 'ghaznavid', label: 'GHAZNAVID', code: 'gz', era: 'early-medieval' },
  { id: 'hoysala', label: 'HOYSALA', code: 'w', era: 'early-medieval' },
  { id: 'eastern-ganga', label: 'EASTERN GANGA', code: 'e', era: 'early-medieval' },
  { id: 'kakatiya', label: 'KAKATIYA', code: 'y', era: 'early-medieval' },
  { id: 'ghurid', label: 'GHURID', code: 'gh', era: 'early-medieval' },
  { id: 'mamluk', label: 'DELHI · MAMLUK', code: 'dm', era: 'late-medieval' },
  { id: 'khalji', label: 'DELHI · KHALJI', code: 'dk', era: 'late-medieval' },
  { id: 'tughlaq', label: 'DELHI · TUGHLAQ', code: 'dt', era: 'late-medieval' },
  { id: 'vijayanagara', label: 'VIJAYANAGARA', code: 'j', era: 'late-medieval' },
  { id: 'bahmani', label: 'BAHMANI', code: 'bh', era: 'late-medieval' },
  { id: 'bengal-sultanate', label: 'BENGAL SULTANATE', code: 'bs', era: 'late-medieval' },
  { id: 'malwa-sultanate', label: 'MALWA SULTANATE', code: 'ms', era: 'late-medieval' },
  { id: 'gujarat-sultanate', label: 'GUJARAT SULTANATE', code: 'gs', era: 'late-medieval' },
  { id: 'sayyid', label: 'DELHI · SAYYID', code: 'ds', era: 'late-medieval' },
  { id: 'lodi', label: 'DELHI · LODI', code: 'dl', era: 'late-medieval' },
  { id: 'deccan-sultanates', label: 'DECCAN SULTANATES', code: 'dc', era: 'late-medieval' },
  { id: 'portuguese', label: 'PORTUGUESE', code: 'pt', era: 'early-modern' },
  { id: 'mughal', label: 'MUGHAL', code: 'mg', era: 'early-modern' },
  { id: 'sur', label: 'SUR', code: 'su', era: 'early-modern' },
  { id: 'dutch', label: 'DUTCH', code: 'nl', era: 'early-modern' },
  { id: 'french', label: 'FRENCH', code: 'fr', era: 'early-modern' },
  { id: 'maratha', label: 'MARATHA', code: 'x', era: 'early-modern' },
  { id: 'hyderabad', label: 'HYDERABAD · NIZAMS', code: 'hy', era: 'early-modern' },
  { id: 'durrani', label: 'DURRANI', code: 'du', era: 'early-modern' },
  { id: 'company-rule', label: 'EAST INDIA COMPANY', code: 'ec', era: 'early-modern' },
  { id: 'mysore', label: 'MYSORE · TIPU', code: 'my', era: 'early-modern' },
  { id: 'sikh', label: 'SIKH EMPIRE', code: 'sk', era: 'early-modern' },
  { id: 'british-raj', label: 'BRITISH RAJ', code: 'br', era: 'early-modern' },
].map((chip) => Object.freeze(chip)));
export const KINGDOM_IDS = Object.freeze(KINGDOM_CHIPS.map((chip) => chip.id));
export const KINGDOM_CODES = Object.freeze(Object.fromEntries(KINGDOM_CHIPS.map((chip) => [chip.id, chip.code])));
export const ERA_IDS = Object.freeze(HISTORY_ERAS.map((era) => era.id));

/** @returns {string|null} The era a kingdom's chip belongs to. */
export function eraOfKingdom(kingdomId) {
  return KINGDOM_CHIPS.find((chip) => chip.id === kingdomId)?.era || null;
}
export const DEFAULT_KINGDOM = 'maurya';

export const HISTORY_COLORS = Object.freeze({
  capital: '#ffd54a',
  city: '#f5f1e6',
  event: '#ff8a65',
});

const WIKI_URL = /^https:\/\/en\.wikipedia\.org\/wiki\/[^\s]+$/;
const CITY_ROLES = new Set(['capital', 'provincial', 'city']);
/** Card detail lines are painted unwrapped, so summaries are wrapped here. */
const CARD_WRAP_CHARS = 46;

/** @returns {boolean} True for an English Wikipedia article URL. */
export function isWikipediaUrl(url) {
  return typeof url === 'string' && WIKI_URL.test(url);
}

/**
 * Format a signed year (negative = BCE) for display.
 * @param {number} year Signed year.
 * @param {boolean} [circa] Prefix "c.".
 * @returns {string} e.g. "c. 261 BCE", "499 CE".
 */
export function formatYear(year, circa = false) {
  if (!Number.isFinite(year)) return '';
  const text = year < 0 ? `${Math.abs(year)} BCE` : `${year} CE`;
  return circa ? `c. ${text}` : text;
}

/**
 * Greedy word wrap.
 * @param {string} text Source text.
 * @param {number} [width] Max characters per line.
 * @returns {string[]} Lines.
 */
export function wrapText(text, width = CARD_WRAP_CHARS) {
  const lines = [];
  let line = '';
  for (const word of String(text || '').split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function validPoint(item) {
  return Number.isFinite(item?.lat) && Number.isFinite(item?.lon)
    && item.lat >= -90 && item.lat <= 90 && item.lon >= -180 && item.lon <= 180;
}

/**
 * Validate the bundled dataset; the layer refuses to render a malformed file.
 * @param {object} data Parsed kingdoms.json.
 * @returns {string[]} Problems found (empty when valid).
 */
export function validateKingdomData(data) {
  const problems = [];
  const kingdoms = Array.isArray(data?.kingdoms) ? data.kingdoms : null;
  if (!kingdoms) return ['kingdoms must be an array'];
  const seen = new Set();
  for (const kingdom of kingdoms) {
    const id = kingdom?.id;
    const at = `kingdom ${id || '?'}`;
    if (typeof id !== 'string' || !id) problems.push('kingdom missing id');
    if (seen.has(id)) problems.push(`${at}: duplicate id`);
    seen.add(id);
    if (!kingdom.name) problems.push(`${at}: missing name`);
    if (!isWikipediaUrl(kingdom.wiki)) problems.push(`${at}: bad wiki url`);
    const { start, end } = kingdom.period || {};
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      problems.push(`${at}: bad period`);
    }
    if (!validPoint(kingdom.anchor)) problems.push(`${at}: bad anchor`);
    const extents = Array.isArray(kingdom.extents) ? kingdom.extents : [];
    if (!extents.length) problems.push(`${at}: no extents`);
    for (const extent of extents) {
      const rings = Array.isArray(extent?.rings) ? extent.rings : [];
      if (!rings.length) problems.push(`${at}: extent ${extent?.id} has no rings`);
      const holes = Array.isArray(extent?.holes) ? extent.holes : [];
      if (holes.length && rings.length !== 1) problems.push(`${at}: extent ${extent?.id} holes need exactly one ring`);
      for (const ring of [...rings, ...holes]) {
        const closed = Array.isArray(ring) && ring.length >= 4
          && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1];
        const finite = Array.isArray(ring) && ring.every((p) => validPoint({ lon: p?.[0], lat: p?.[1] }));
        if (!closed || !finite) problems.push(`${at}: extent ${extent?.id} ring is not a closed lon/lat ring`);
      }
    }
    for (const city of kingdom.cities || []) {
      if (!city?.id || !city.name || !validPoint(city)) problems.push(`${at}: bad city ${city?.id}`);
      if (!CITY_ROLES.has(city?.role)) problems.push(`${at}: city ${city?.id} bad role`);
      if (!isWikipediaUrl(city?.wiki)) problems.push(`${at}: city ${city?.id} bad wiki url`);
    }
    for (const event of kingdom.events || []) {
      if (!event?.id || !event.title || !event.summary || !validPoint(event)) {
        problems.push(`${at}: bad event ${event?.id}`);
      }
      if (!isWikipediaUrl(event?.wiki)) problems.push(`${at}: event ${event?.id} bad wiki url`);
      if (!Number.isFinite(event?.year) || event.year < start || event.year > end) {
        problems.push(`${at}: event ${event?.id} year outside period`);
      }
    }
  }
  return problems;
}

/** Events in chronological order, numbered from 1. */
export function orderedEvents(kingdom) {
  return [...(kingdom?.events || [])]
    .sort((a, b) => a.year - b.year)
    .map((event, index) => ({ ...event, number: index + 1 }));
}

/** Rounded site key, so a city and an event at one place share a single marker. */
export function siteKey(item) {
  return `${Number(item.lat).toFixed(2)},${Number(item.lon).toFixed(2)}`;
}

/** Overlap area of two centre-anchored boxes. */
function overlapArea(a, b) {
  const w = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);
  const h = Math.min(a.y + a.h / 2, b.y + b.h / 2) - Math.max(a.y - a.h / 2, b.y - b.h / 2);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Screen-space label placement. Cesium labels never declutter themselves, and
 * nearby sites (a few degrees apart on the Gangetic plain) overprint at the
 * altitudes the layer flies to. Greedy, in priority order: each label takes
 * its first candidate offset that overlaps nothing already placed; an
 * `optional` label with no free spot is hidden, any other takes its
 * least-overlapping candidate.
 * @param {Array<{id:string,x:number,y:number,w:number,h:number,
 *   candidates:Array<[number,number]>,optional?:boolean}>} items Anchor (x,y) in
 *   CSS px, label box size, and candidate centre offsets, highest priority first.
 * @param {Array<{x:number,y:number,w:number,h:number}>} [obstacles] Fixed boxes (markers).
 * @returns {Map<string,{dx:number,dy:number,show:boolean}>} Placement per id.
 */
export function planLabelLayout(items, obstacles = []) {
  const placed = [...obstacles];
  const plan = new Map();
  for (const item of items) {
    let best = null;
    let bestOverlap = Infinity;
    for (const [dx, dy] of item.candidates) {
      const box = { x: item.x + dx, y: item.y + dy, w: item.w, h: item.h };
      let overlap = 0;
      for (const other of placed) overlap += overlapArea(box, other);
      if (overlap < bestOverlap) {
        best = { box, dx, dy };
        bestOverlap = overlap;
        if (overlap === 0) break;
      }
    }
    if (!best || (bestOverlap > 0 && item.optional)) {
      plan.set(item.id, { dx: 0, dy: 0, show: false });
      continue;
    }
    placed.push(best.box);
    plan.set(item.id, { dx: best.dx, dy: best.dy, show: true });
  }
  return plan;
}

/** Candidate centre offsets for a city label: above, right, left, below its marker. */
export function cityLabelCandidates(w, h) {
  const gapY = h / 2 + 8;
  const gapX = w / 2 + 9;
  return [[0, -gapY], [gapX, 0], [-gapX, 0], [0, gapY]];
}

/**
 * Candidate centre offsets for an event label, nearest first: directly below
 * the marker, then above, then beside it, then further rows out in every
 * direction. Searching outward (rather than down one column) keeps a crowded
 * site's labels next to their own marker instead of drifting up beside some
 * other city.
 * @param {number} w Label box width.
 * @param {number} h Label box height.
 * @param {number} [rows] How many rows out to search.
 * @returns {Array<[number, number]>} Offsets.
 */
export function eventLabelCandidates(w, h, rows = 6) {
  const step = h + 2;
  const first = h / 2 + 7;
  const side = w / 2 + 9;
  const out = [];
  for (let i = 0; i < rows; i++) {
    out.push([0, first + i * step], [0, -first - i * step]);
  }
  for (let i = -rows + 1; i < rows; i++) {
    out.push([side, i * step], [-side, i * step]);
  }
  // Stable sort by distance; a small bias keeps "below" ahead of equal ties.
  const cost = ([dx, dy]) => Math.hypot(dx, dy) - (dx === 0 && dy > 0 ? 0.5 : 0);
  return out.map((c, i) => ({ c, i, d: cost(c) })).sort((a, b) => a.d - b.d || a.i - b.i).map((x) => x.c);
}

/** Status line under the layer's toggle row. */
export function describeIndianHistoryState({ kingdom = null, error = null, loading = false } = {}) {
  if (error) return `history data unavailable · ${error}`;
  if (!kingdom) return loading ? 'loading kingdoms…' : 'pick a kingdom';
  const cities = kingdom.cities?.length || 0;
  const events = kingdom.events?.length || 0;
  return `${kingdom.name} · ${kingdom.period.label} · ${cities} cities · ${events} events · borders approximate`;
}

/** Legend rows for the layer's row controls. */
export function historyLegend(kingdom) {
  const cities = kingdom?.cities || [];
  const capitals = cities.filter((city) => city.role === 'capital').length;
  return [
    { id: 'capital', label: 'Capital', color: HISTORY_COLORS.capital, count: capitals },
    { id: 'city', label: 'City', color: HISTORY_COLORS.city, count: cities.length - capitals },
    { id: 'event', label: 'Event', color: HISTORY_COLORS.event, count: kingdom?.events?.length || 0 },
  ];
}

const ROLE_LABELS = { capital: 'Capital', provincial: 'Provincial capital', city: 'City' };
const LINK_HINT = '↗ Click the card for Wikipedia · ✕ to close';

function cardBase(id, position, accent) {
  return {
    id,
    source: INDIAN_HISTORY_OVERLAY_SOURCE_ID,
    position,
    variant: 'card',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    zIndex: 40,
    accent,
    interactive: true,
    closable: true,
    verticalOnly: true,
    placement: 'above',
    gapPx: 14,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
  };
}

/**
 * Card for a selected city, event, or the kingdom itself.
 * @param {'kingdom'|'city'|'event'} kind What was selected.
 * @param {object} kingdom Kingdom record.
 * @param {object} item City or (numbered) event; the kingdom for `kind: 'kingdom'`.
 * @param {object} position Card anchor (Cesium.Cartesian3).
 * @returns {object} World-overlay entry. `wiki` is the link the card opens.
 */
export function createHistoryCardEntry(kind, kingdom, item, position) {
  if (kind === 'kingdom') {
    return {
      ...cardBase(`selected:kingdom:${kingdom.id}`, position, kingdom.color),
      title: kingdom.name,
      details: [
        `${kingdom.period.label} · borders approximate`,
        ...wrapText(kingdom.summary),
        LINK_HINT,
      ],
      accessibilityLabel: `Open Wikipedia: ${kingdom.name}`,
      wiki: kingdom.wiki,
    };
  }
  if (kind === 'city') {
    return {
      ...cardBase(`selected:city:${kingdom.id}:${item.id}`, position, HISTORY_COLORS[item.role === 'capital' ? 'capital' : 'city']),
      title: item.name,
      details: [
        `${ROLE_LABELS[item.role] || 'City'} · ${kingdom.name}`,
        ...wrapText(item.note),
        LINK_HINT,
      ],
      accessibilityLabel: `Open Wikipedia: ${item.name}`,
      wiki: item.wiki,
    };
  }
  return {
    ...cardBase(`selected:event:${kingdom.id}:${item.id}`, position, HISTORY_COLORS.event),
    title: `${item.number ? `${item.number}. ` : ''}${item.title}`,
    details: [
      `${formatYear(item.year, item.circa)} · ${kingdom.name}`,
      ...wrapText(item.summary),
      LINK_HINT,
    ],
    accessibilityLabel: `Open Wikipedia: ${item.title}`,
    wiki: item.wiki,
  };
}
