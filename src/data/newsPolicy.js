/**
 * @module newsPolicy
 * @description Pure decision logic for the News layer — no Cesium, no DOM, no
 * `node:` imports, no `import.meta.env`. Shared verbatim between the browser
 * layer (`src/data/news.js`) and the ingester (`scripts/news-ingest.mjs`) so
 * the impact a pin is painted with is the same number the ingester wrote.
 *
 * Everything here is deterministic. Given the same articles it returns the
 * same ids, the same clusters and the same scores, on any machine, forever —
 * which is what lets `newsPlacement.js` derive a stable pin position from an
 * id, and what lets a share link mean the same thing tomorrow.
 */

/**
 * Identifier for the grading method, stored per row in `news.graded_by`.
 *
 * Bump the suffix whenever the thresholds or the clustering change, so a
 * mixed-vintage database stays honest about which rows were scored how.
 * `coverage-v1` is pure syndication counting: how many distinct outlets ran
 * the same story. It is a measurement, not an opinion — deliberately, because
 * the repo's ground rules forbid presenting inference as intelligence.
 */
export const NEWS_GRADER_ID = 'coverage-v1';

/**
 * Impact bands, highest first. `color` is the pin colour; `dotPx` and
 * `labelPriority` exist so impact reads through size and label survival too,
 * not hue alone — the map has to stay legible in the thermal and noir visual
 * styles, and for anyone who cannot separate red from green.
 * @type {ReadonlyArray<{impact:number,id:string,label:string,color:string,dotPx:number,labelPriority:number,blurb:string}>}
 */
export const NEWS_IMPACT_BANDS = Object.freeze([
  Object.freeze({ impact: 5, id: 'critical', label: 'CRITICAL', color: '#FF2D2D', dotPx: 14, labelPriority: 5000, blurb: 'Ran on 12 or more outlets' }),
  Object.freeze({ impact: 4, id: 'major', label: 'MAJOR', color: '#FF6B1A', dotPx: 12, labelPriority: 4000, blurb: 'Ran on 6 or more outlets' }),
  Object.freeze({ impact: 3, id: 'notable', label: 'NOTABLE', color: '#FFC21A', dotPx: 10, labelPriority: 3000, blurb: 'Ran on 3 or more outlets' }),
  Object.freeze({ impact: 2, id: 'routine', label: 'ROUTINE', color: '#7ED957', dotPx: 8, labelPriority: 2000, blurb: 'Ran on 2 outlets' }),
  Object.freeze({ impact: 1, id: 'minor', label: 'MINOR', color: '#4FC3D9', dotPx: 7, labelPriority: 1000, blurb: 'Single outlet' }),
]);

/**
 * Distinct-outlet thresholds, highest first. Calibrated against a 250-record
 * daily sample (the DOC API's `maxrecords` ceiling for one country-day): at
 * that sample size a story on a dozen domains is genuinely the day's headline.
 * Re-calibrate if you change the sample size — these are counts, not ratios.
 * @type {ReadonlyArray<{minDomains:number,impact:number}>}
 */
export const COVERAGE_IMPACT_THRESHOLDS = Object.freeze([
  Object.freeze({ minDomains: 12, impact: 5 }),
  Object.freeze({ minDomains: 6, impact: 4 }),
  Object.freeze({ minDomains: 3, impact: 3 }),
  Object.freeze({ minDomains: 2, impact: 2 }),
  Object.freeze({ minDomains: 0, impact: 1 }),
]);

/**
 * Similarity above which two headlines are treated as the same story.
 *
 * 0.55 is where the two failure modes balance, measured against
 * `src/data/fixtures/gdelt-doc-artlist-synthetic.json`. Lower and
 * "Sensex closes higher" merges with "Sensex closes lower" — different
 * stories, same words. Higher and genuine syndication splits, which
 * under-counts coverage and therefore under-grades impact.
 */
export const HEADLINE_CLUSTER_THRESHOLD = 0.55;
/** Words per shingle. Two, not three — news headlines are short. */
export const HEADLINE_SHINGLE_SIZE = 2;

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const MS_PER_DAY = 86_400_000;

/**
 * Headline noise. Deliberately short: an aggressive stoplist merges unrelated
 * stories, which is a worse failure than splitting one story in two.
 */
const HEADLINE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'has', 'have', 'had',
  'are', 'was', 'were', 'will', 'would', 'says', 'said', 'after', 'over',
  'into', 'amid', 'its', 'his', 'her', 'their', 'they', 'but', 'not', 'you',
  'who', 'why', 'how', 'what', 'when', 'where', 'new', 'news', 'live',
  'updates', 'update', 'video', 'watch', 'read', 'here', 'more', 'top',
]);

// ---------------------------------------------------------------------------
// Normalization — every untrusted value enters through one of these
// ---------------------------------------------------------------------------

/**
 * Normalize an ISO 3166-1 alpha-2 country code.
 * Rejects rather than coerces: half a country code is a different country.
 * @param {*} value Untrusted country input.
 * @returns {string|null} Uppercase two-letter code, or null.
 */
export function normalizeCountryCode(value) {
  const text = String(value ?? '').trim().toUpperCase();
  return COUNTRY_PATTERN.test(text) ? text : null;
}

/**
 * Normalize a `YYYY-MM-DD` UTC day key.
 *
 * Round-trips through Date to reject calendar-impossible dates that match the
 * pattern (`2026-02-31`). Rejects; never clamps — a clamped date silently
 * shows the wrong day's news, which the UI would then report as correct.
 * @param {*} value Untrusted date input.
 * @returns {string|null} The day key, or null.
 */
export function normalizeDayKey(value) {
  const text = String(value ?? '').trim();
  if (!DAY_KEY_PATTERN.test(text)) return null;
  const ms = Date.parse(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return null;
  return dayKeyFromMs(ms) === text ? text : null;
}

/**
 * UTC day key for an epoch-milliseconds instant.
 * @param {number} ms Epoch milliseconds.
 * @returns {string|null} `YYYY-MM-DD`, or null when ms is not finite.
 */
export function dayKeyFromMs(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Shift a day key by whole days.
 * @param {string} dayKey Valid `YYYY-MM-DD`.
 * @param {number} delta Days to add; may be negative.
 * @returns {string|null} The shifted day key, or null on invalid input.
 */
export function addDays(dayKey, delta) {
  const day = normalizeDayKey(dayKey);
  const step = Number(delta);
  if (!day || !Number.isFinite(step)) return null;
  return dayKeyFromMs(Date.parse(`${day}T00:00:00.000Z`) + Math.trunc(step) * MS_PER_DAY);
}

/**
 * Inclusive ascending list of day keys between two dates.
 * @param {string} fromDay Valid `YYYY-MM-DD`.
 * @param {string} toDay Valid `YYYY-MM-DD`, not before fromDay.
 * @returns {string[]} Day keys, or an empty array on invalid or inverted input.
 */
export function dayKeyRange(fromDay, toDay) {
  const start = normalizeDayKey(fromDay);
  const end = normalizeDayKey(toDay);
  if (!start || !end) return [];
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const endMs = Date.parse(`${end}T00:00:00.000Z`);
  if (endMs < startMs) return [];
  const days = [];
  for (let ms = startMs; ms <= endMs; ms += MS_PER_DAY) days.push(dayKeyFromMs(ms));
  return days;
}

// ---------------------------------------------------------------------------
// GDELT wire formats
// ---------------------------------------------------------------------------

/**
 * Render a day key as a GDELT `YYYYMMDDHHMMSS` stamp.
 * @param {string} dayKey Valid `YYYY-MM-DD`.
 * @param {'start'|'end'} [boundary] Start or end of the UTC day.
 * @returns {string|null} The stamp, or null on invalid input.
 */
export function gdeltStamp(dayKey, boundary = 'start') {
  const day = normalizeDayKey(dayKey);
  if (!day) return null;
  return `${day.replaceAll('-', '')}${boundary === 'end' ? '235959' : '000000'}`;
}

/**
 * Split a UTC day into GDELT request windows.
 *
 * One request per day does not work. GDELT caps `artlist` at 250 records, and
 * a day of Indian English news is tens of thousands of articles — so a single
 * call returns roughly 1% of the day, which is both too small for syndication
 * to be visible AND, measured against a real run, dominated by whichever media
 * group the relevance sort happens to favour (the first live run returned 500
 * rows from 8 publishers, all one group, covering only 9 of 24 hours).
 *
 * Slicing the day and sorting each slice by date instead fixes both: every
 * hour of the day is represented, and the 250-record ceiling applies per slice
 * rather than per day.
 * Windows that start in the future are never emitted. GDELT answers those with
 * HTTP 200 and the plain text "Invalid query start date" — measured on the
 * first full run, where today's six remaining windows each burned four retries
 * on a request that could never succeed.
 * @param {string} dayKey Valid `YYYY-MM-DD`.
 * @param {number} [sliceHours] Hours per window; clamped to 1..24.
 * @param {object} [options] Clock injection.
 * @param {number} [options.nowMs] Epoch ms treated as "now"; defaults to the real clock.
 * @returns {Array<{start:string,end:string}>} GDELT `YYYYMMDDHHMMSS` bounds.
 */
export function gdeltDayWindows(dayKey, sliceHours = 2, { nowMs = Date.now() } = {}) {
  const day = normalizeDayKey(dayKey);
  if (!day) return [];
  // Clamp rather than fall back on 0: an explicit --slice-hours=0 means "as
  // fine as you can", not "use the default".
  const requested = Number(sliceHours);
  const span = Number.isFinite(requested) ? Math.min(24, Math.max(1, Math.trunc(requested))) : 2;
  const stamp = day.replaceAll('-', '');
  const pad = (value) => String(value).padStart(2, '0');
  const dayStartMs = Date.parse(`${day}T00:00:00.000Z`);
  const windows = [];
  for (let hour = 0; hour < 24; hour += span) {
    // A window whose start has not happened yet cannot return anything.
    if (dayStartMs + hour * 3_600_000 >= nowMs) break;
    const endHour = Math.min(24, hour + span);
    windows.push({
      start: `${stamp}${pad(hour)}0000`,
      // The last window ends at 23:59:59 rather than rolling into the next
      // day, so adjacent days never both claim the same midnight article.
      end: endHour === 24 ? `${stamp}235959` : `${stamp}${pad(endHour)}0000`,
    });
  }
  return windows;
}

/**
 * Parse GDELT's `seendate` (`20260824T091500Z`) into an ISO 8601 string.
 * @param {*} value Raw seendate.
 * @returns {string|null} ISO 8601 UTC, or null when unparseable.
 */
export function parseGdeltSeenDate(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/.exec(text);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Repair GDELT's tokenised headline text for display.
 *
 * The DOC API returns titles with punctuation split off as separate tokens:
 * "India , China discuss ways to maintain peace along LAC" and
 * "FBI sets $25 , 000 minimum reward". 44% of a real India day's rows are
 * affected, so this is not cosmetic — it is most of the text a reader sees.
 *
 * Deliberately conservative. The one judgement call is ` - `, which GDELT
 * produces for hyphenated compounds ("month - end" for "month-end"); joining
 * it would be wrong for a genuine parenthetical dash, but GDELT's tokeniser
 * does not emit those, so the common case wins.
 * @param {*} title Raw GDELT title.
 * @returns {string} Display-ready headline.
 */
export function tidyHeadline(title) {
  return String(title ?? '')
    .replace(/\s+([,.;:!?%])/g, '$1')
    .replace(/(\d),\s+(\d{3})\b/g, '$1,$2')
    .replace(/([(\[])\s+/g, '$1')
    .replace(/\s+([)\]])/g, '$1')
    .replace(/(\w)\s+-\s+(\w)/g, '$1-$2')
    .replace(/\s+'\s*/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Stable identity
// ---------------------------------------------------------------------------

/**
 * FNV-1a 32-bit hash. Not cryptographic — it only has to be stable and evenly
 * spread, and it has to produce the same value in Node and in the browser.
 * @param {string} text Input.
 * @returns {number} Unsigned 32-bit hash.
 */
export function fnv1a32(text) {
  let hash = 0x811c9dc5;
  const input = String(text ?? '');
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Strip the parts of a URL that change without the article changing —
 * scheme, `www.`, tracking query, fragment, trailing slash — so the same story
 * re-ingested from an http/https or utm-tagged variant keeps one identity.
 * @param {*} value Article URL.
 * @returns {string} Canonical form (lowercased host, path preserved).
 */
export function canonicalArticleUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const stripped = text
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('#')[0]
    .replace(/[?&](utm_[^=&]*|fbclid|gclid|igshid|ref|source)=[^&]*/gi, '')
    .replace(/[?&]+$/, '')
    .replace(/\/+$/, '');
  const slash = stripped.indexOf('/');
  if (slash === -1) return stripped.toLowerCase();
  return stripped.slice(0, slash).toLowerCase() + stripped.slice(slash);
}

/**
 * Build the stable primary key for one article.
 *
 * This id is load-bearing twice over: it is the upsert key that makes
 * overlapping ingest windows idempotent, and it is what `newsPlacement.js`
 * hashes to choose the pin's coordinates. A regenerated id moves the pin, so
 * it must depend only on values that never change for a given article.
 * @param {string} country ISO alpha-2 country code.
 * @param {string} dayKey `YYYY-MM-DD` UTC day.
 * @param {string} url Article URL.
 * @returns {string|null} e.g. `in-2026-08-24-1f3a9c02`, or null on bad input.
 */
export function stableArticleId(country, dayKey, url) {
  const code = normalizeCountryCode(country);
  const day = normalizeDayKey(dayKey);
  const canonical = canonicalArticleUrl(url);
  if (!code || !day || !canonical) return null;
  const digest = fnv1a32(`${code}|${day}|${canonical}`).toString(16).padStart(8, '0');
  return `${code.toLowerCase()}-${day}-${digest}`;
}

// ---------------------------------------------------------------------------
// Headline clustering — "how many outlets ran this story"
// ---------------------------------------------------------------------------

/**
 * Lowercase, de-accent and strip punctuation from a headline.
 * @param {*} title Raw headline.
 * @returns {string} Normalized text.
 */
export function normalizeHeadline(title) {
  return String(title ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Content words of a headline, in order, with noise and short tokens dropped.
 * @param {*} title Raw headline.
 * @returns {string[]} Tokens.
 */
export function headlineTokens(title) {
  const normalized = normalizeHeadline(title);
  if (!normalized) return [];
  return normalized.split(' ').filter((token) => token.length >= 3 && !HEADLINE_STOPWORDS.has(token));
}

/**
 * Word-shingle set for a headline. Falls back to the bare token set when the
 * headline is too short to shingle, so two-word headlines still cluster.
 * @param {*} title Raw headline.
 * @param {number} [size] Words per shingle.
 * @returns {Set<string>} Shingles.
 */
export function headlineShingles(title, size = HEADLINE_SHINGLE_SIZE) {
  const tokens = headlineTokens(title);
  const width = Math.max(1, Math.trunc(Number(size) || 1));
  if (tokens.length < width + 1) return new Set(tokens);
  const shingles = new Set();
  for (let i = 0; i + width <= tokens.length; i++) shingles.add(tokens.slice(i, i + width).join(' '));
  return shingles;
}

/**
 * Jaccard similarity of two sets. Two empty sets are dissimilar, not
 * identical — otherwise every untitled article collapses into one story.
 * @param {Set<string>} a First set.
 * @param {Set<string>} b Second set.
 * @returns {number} 0..1.
 */
export function jaccard(a, b) {
  if (!a?.size || !b?.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const value of small) if (large.has(value)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Similarity of two headlines: the better of order-free and order-sensitive.
 *
 * Token-set overlap leads because newsrooms reorder constantly — "Cyclone
 * Remal makes landfall on the Odisha coast" and "Landfall: Cyclone Remal hits
 * the Odisha coast" are one story, but they share only two of eight word
 * pairs, so shingles alone score them 0.25 and split the cluster. The shingle
 * score is kept as the max's other half: it rescues pairs whose shared
 * phrasing is longer than their shared vocabulary suggests.
 * @param {*} titleA First headline.
 * @param {*} titleB Second headline.
 * @param {number} [shingleSize] Words per shingle.
 * @returns {number} 0..1.
 */
export function headlineSimilarity(titleA, titleB, shingleSize = HEADLINE_SHINGLE_SIZE) {
  const tokenScore = jaccard(new Set(headlineTokens(titleA)), new Set(headlineTokens(titleB)));
  const shingleScore = jaccard(headlineShingles(titleA, shingleSize), headlineShingles(titleB, shingleSize));
  return Math.max(tokenScore, shingleScore);
}

/**
 * Single-link cluster a list of headlines by similarity.
 *
 * O(n²) on purpose: n is one country-day, capped at 250 by the DOC API, so
 * this is ~31k cheap set intersections. Single-link (rather than complete)
 * because syndicated copy drifts — outlet A and outlet C often only resemble
 * each other through B's phrasing.
 * @param {Array<{title?:string}>} items Articles.
 * @param {object} [options] Tuning.
 * @param {number} [options.threshold] Minimum similarity to link two items.
 * @param {number} [options.shingleSize] Words per shingle.
 * @returns {number[]} Cluster index per item, aligned with `items`.
 */
export function clusterHeadlines(items, { threshold = HEADLINE_CLUSTER_THRESHOLD, shingleSize = HEADLINE_SHINGLE_SIZE } = {}) {
  const list = Array.isArray(items) ? items : [];
  const parent = list.map((_, index) => index);
  const find = (index) => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    let walk = index;
    while (parent[walk] !== root) {
      const next = parent[walk];
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
  };

  const tokens = list.map((item) => new Set(headlineTokens(item?.title)));
  const shingles = list.map((item) => headlineShingles(item?.title, shingleSize));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const score = Math.max(jaccard(tokens[i], tokens[j]), jaccard(shingles[i], shingles[j]));
      if (score >= threshold) union(i, j);
    }
  }

  // Renumber roots to dense 0..n-1 in first-appearance order, so cluster ids
  // are stable for a given input rather than depending on array indices.
  const dense = new Map();
  return list.map((_, index) => {
    const root = find(index);
    if (!dense.has(root)) dense.set(root, dense.size);
    return dense.get(root);
  });
}

// ---------------------------------------------------------------------------
// Impact
// ---------------------------------------------------------------------------

/**
 * Map a distinct-outlet count onto a 1..5 impact score.
 * @param {number} distinctDomains Number of unique publishers carrying the story.
 * @returns {number} Impact, 1..5.
 */
export function coverageImpact(distinctDomains) {
  const count = Math.max(0, Math.trunc(Number(distinctDomains) || 0));
  for (const band of COVERAGE_IMPACT_THRESHOLDS) if (count >= band.minDomains) return band.impact;
  return 1;
}

/**
 * Look up the presentation band for an impact score, clamping out of range.
 * @param {*} impact Impact score.
 * @returns {{impact:number,id:string,label:string,color:string,dotPx:number,labelPriority:number,blurb:string}} Band.
 */
export function impactBand(impact) {
  const score = Math.min(5, Math.max(1, Math.round(Number(impact) || 1)));
  return NEWS_IMPACT_BANDS.find((band) => band.impact === score) || NEWS_IMPACT_BANDS.at(-1);
}

/**
 * Score one country-day's articles by how widely each story was syndicated.
 *
 * Pure and total: returns a new array, never mutates the input, and tolerates
 * missing titles, domains and urls (an article with neither title nor domain
 * simply scores 1 rather than throwing).
 * @param {Array<{url?:string,domain?:string,title?:string}>} articles One day's articles.
 * @param {object} [options] Clustering tuning, forwarded to clusterHeadlines.
 * @returns {Array<object>} Input objects plus `clusterId`, `clusterSize`,
 *   `distinctDomains` and `impact`.
 */
export function gradeByCoverage(articles, options = {}) {
  const list = Array.isArray(articles) ? articles : [];
  if (list.length === 0) return [];
  const clusterIds = clusterHeadlines(list, options);

  /** @type {Map<number, Set<string>>} */
  const domainsByCluster = new Map();
  /** @type {Map<number, number>} */
  const sizeByCluster = new Map();
  list.forEach((article, index) => {
    const cluster = clusterIds[index];
    sizeByCluster.set(cluster, (sizeByCluster.get(cluster) || 0) + 1);
    if (!domainsByCluster.has(cluster)) domainsByCluster.set(cluster, new Set());
    const domain = String(article?.domain ?? '').trim().toLowerCase();
    if (domain) domainsByCluster.get(cluster).add(domain);
  });

  return list.map((article, index) => {
    const cluster = clusterIds[index];
    const distinctDomains = domainsByCluster.get(cluster)?.size || 0;
    return {
      ...article,
      clusterId: cluster,
      clusterSize: sizeByCluster.get(cluster) || 1,
      distinctDomains,
      impact: coverageImpact(distinctDomains),
    };
  });
}

/**
 * Build the toggle-row legend from a per-impact tally, dropping empty bands so
 * a quiet day does not render five zeroes.
 * @param {Record<number, number>|Map<number, number>} tally Counts keyed by impact.
 * @returns {Array<{label:string,color:string,count:number,blurb:string}>} Legend entries.
 */
export function newsImpactLegend(tally) {
  const read = (impact) => Number(
    (tally instanceof Map ? tally.get(impact) : tally?.[impact]) ?? 0,
  ) || 0;
  return NEWS_IMPACT_BANDS
    .map((band) => ({ label: band.label, color: band.color, count: read(band.impact), blurb: band.blurb }))
    .filter((entry) => entry.count > 0);
}
