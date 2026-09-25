import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NEWS_IMPACT_BANDS,
  addDays,
  canonicalArticleUrl,
  clusterHeadlines,
  coverageImpact,
  dayKeyFromMs,
  dayKeyRange,
  gdeltDayWindows,
  gdeltStamp,
  gradeByCoverage,
  headlineShingles,
  headlineSimilarity,
  headlineTokens,
  impactBand,
  jaccard,
  newsImpactLegend,
  normalizeCountryCode,
  normalizeDayKey,
  normalizeHeadline,
  parseGdeltSeenDate,
  stableArticleId,
} from './newsPolicy.js';

// ── Normalization: reject, never coerce ────────────────────────────────────

test('normalizeCountryCode accepts alpha-2 and rejects everything else', () => {
  assert.equal(normalizeCountryCode('in'), 'IN');
  assert.equal(normalizeCountryCode('  us  '), 'US');
  assert.equal(normalizeCountryCode('IND'), null);
  assert.equal(normalizeCountryCode('I'), null);
  assert.equal(normalizeCountryCode('I1'), null);
  assert.equal(normalizeCountryCode(''), null);
  assert.equal(normalizeCountryCode(null), null);
  assert.equal(normalizeCountryCode("IN'; DROP TABLE news;--"), null);
});

test('normalizeDayKey rejects calendar-impossible dates rather than clamping', () => {
  assert.equal(normalizeDayKey('2026-08-24'), '2026-08-24');
  assert.equal(normalizeDayKey('2024-02-29'), '2024-02-29', 'leap day is real');
  assert.equal(normalizeDayKey('2026-02-29'), null, '2026 is not a leap year');
  assert.equal(normalizeDayKey('2026-02-31'), null);
  assert.equal(normalizeDayKey('2026-13-01'), null);
  assert.equal(normalizeDayKey('2026-8-24'), null, 'unpadded month is not the format');
  assert.equal(normalizeDayKey('2026-08-24T00:00:00Z'), null);
  assert.equal(normalizeDayKey(undefined), null);
});

test('day arithmetic crosses month, year and leap boundaries', () => {
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('nope', 1), null);
  assert.equal(dayKeyFromMs(Date.parse('2026-08-24T23:59:59Z')), '2026-08-24');
  assert.equal(dayKeyFromMs(Number.NaN), null);
});

test('dayKeyRange is inclusive, ascending, and empty when inverted', () => {
  assert.deepEqual(dayKeyRange('2026-08-24', '2026-08-26'), ['2026-08-24', '2026-08-25', '2026-08-26']);
  assert.deepEqual(dayKeyRange('2026-08-24', '2026-08-24'), ['2026-08-24']);
  assert.deepEqual(dayKeyRange('2026-08-26', '2026-08-24'), []);
  assert.deepEqual(dayKeyRange('bad', '2026-08-24'), []);
});

// ── GDELT wire formats ─────────────────────────────────────────────────────

test('gdeltStamp brackets the whole UTC day', () => {
  assert.equal(gdeltStamp('2026-08-24'), '20260824000000');
  assert.equal(gdeltStamp('2026-08-24', 'end'), '20260824235959');
  assert.equal(gdeltStamp('2026-02-31', 'end'), null);
});

test('gdeltDayWindows covers the whole day without overlapping the next', () => {
  const hourly = gdeltDayWindows('2026-08-24', 1);
  assert.equal(hourly.length, 24);
  assert.equal(hourly[0].start, '20260824000000');
  assert.equal(hourly[0].end, '20260824010000');
  assert.equal(hourly.at(-1).start, '20260824230000');
  assert.equal(hourly.at(-1).end, '20260824235959', 'must not roll into the next day');

  const twoHourly = gdeltDayWindows('2026-08-24', 2);
  assert.equal(twoHourly.length, 12);
  for (let i = 1; i < twoHourly.length; i++) {
    assert.equal(twoHourly[i].start, twoHourly[i - 1].end, 'windows must be contiguous');
  }
});

test('gdeltDayWindows clamps the slice size and rejects bad days', () => {
  const past = { nowMs: Date.parse('2027-01-01T00:00:00Z') };
  assert.equal(gdeltDayWindows('2026-08-24', 24, past).length, 1);
  assert.equal(gdeltDayWindows('2026-08-24', 99, past).length, 1, 'clamped to a single window');
  assert.equal(gdeltDayWindows('2026-08-24', 0, past).length, 24, 'clamped up to hourly');
  assert.deepEqual(gdeltDayWindows('2026-02-31', 2, past), []);
});

test('gdeltDayWindows never asks GDELT about the future', () => {
  // Mid-afternoon on the day being ingested: the remaining hours have not
  // happened, and GDELT answers those with "Invalid query start date".
  const partial = gdeltDayWindows('2026-08-27', 1, { nowMs: Date.parse('2026-08-27T17:30:00Z') });
  assert.equal(partial.length, 18, 'hours 00..17 only');
  assert.equal(partial.at(-1).start, '20260827170000');

  const untouched = gdeltDayWindows('2026-08-26', 1, { nowMs: Date.parse('2026-08-27T17:30:00Z') });
  assert.equal(untouched.length, 24, 'a completed day is still fetched whole');

  const future = gdeltDayWindows('2026-09-01', 1, { nowMs: Date.parse('2026-08-27T17:30:00Z') });
  assert.deepEqual(future, [], 'a day that has not started yields nothing');
});

test('parseGdeltSeenDate handles the documented shape and refuses junk', () => {
  assert.equal(parseGdeltSeenDate('20260824T091500Z'), '2026-08-24T09:15:00.000Z');
  assert.equal(parseGdeltSeenDate('20260824091500'), '2026-08-24T09:15:00.000Z');
  assert.equal(parseGdeltSeenDate('2026-08-24'), null);
  assert.equal(parseGdeltSeenDate(''), null);
  assert.equal(parseGdeltSeenDate(null), null);
});

// ── Stable identity: the pin must not move ─────────────────────────────────

test('canonicalArticleUrl collapses the variants that do not change the article', () => {
  const canonical = 'example.com/a/story';
  assert.equal(canonicalArticleUrl('https://www.example.com/a/story'), canonical);
  assert.equal(canonicalArticleUrl('http://example.com/a/story/'), canonical);
  assert.equal(canonicalArticleUrl('https://EXAMPLE.com/a/story#lead'), canonical);
  assert.equal(canonicalArticleUrl('https://example.com/a/story?utm_source=x'), canonical);
  assert.equal(canonicalArticleUrl('https://example.com/a/Story'), 'example.com/a/Story', 'path case is significant');
  assert.equal(canonicalArticleUrl(''), '');
});

test('stableArticleId is deterministic across re-ingestion of the same article', () => {
  const first = stableArticleId('IN', '2026-08-24', 'https://www.thehindu.com/news/national/x.ece');
  const again = stableArticleId('in', '2026-08-24', 'http://thehindu.com/news/national/x.ece/?utm_medium=rss');
  assert.equal(first, again, 'a url variant must not mint a second id, or the pin moves');
  assert.match(first, /^in-2026-08-24-[0-9a-f]{8}$/);
});

test('stableArticleId separates country, day and article', () => {
  const base = stableArticleId('IN', '2026-08-24', 'https://example.com/a');
  assert.notEqual(base, stableArticleId('US', '2026-08-24', 'https://example.com/a'));
  assert.notEqual(base, stableArticleId('IN', '2026-08-25', 'https://example.com/a'));
  assert.notEqual(base, stableArticleId('IN', '2026-08-24', 'https://example.com/b'));
});

test('stableArticleId refuses to invent an id from bad input', () => {
  assert.equal(stableArticleId('INDIA', '2026-08-24', 'https://example.com/a'), null);
  assert.equal(stableArticleId('IN', '2026-02-31', 'https://example.com/a'), null);
  assert.equal(stableArticleId('IN', '2026-08-24', ''), null);
});

test('stableArticleId is stable over many ids and spreads across the space', () => {
  const ids = new Set();
  for (let i = 0; i < 2000; i++) ids.add(stableArticleId('IN', '2026-08-24', `https://example.com/story/${i}`));
  assert.equal(ids.size, 2000, 'no collisions across a realistic day');
});

// ── Headline handling ──────────────────────────────────────────────────────

test('normalizeHeadline strips accents, case and punctuation', () => {
  assert.equal(normalizeHeadline('Modi announces Bengalūru café protégé!'), 'modi announces bengaluru cafe protege');
  assert.equal(normalizeHeadline(null), '');
});

test('headlineTokens drops stopwords and short tokens', () => {
  assert.deepEqual(headlineTokens('The new cyclone will hit the coast'), ['cyclone', 'hit', 'coast']);
});

test('headlineShingles falls back to tokens for very short headlines', () => {
  assert.deepEqual([...headlineShingles('Cyclone hits Odisha coast')], ['cyclone hits', 'hits odisha', 'odisha coast']);
  assert.deepEqual([...headlineShingles('Budget passed')], ['budget', 'passed'], 'too short to shingle');
});

test('jaccard treats empty sets as dissimilar, not identical', () => {
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['b', 'c'])), 1 / 3);
  assert.equal(jaccard(new Set(), new Set()), 0, 'untitled articles must not collapse into one story');
});

test('headlineSimilarity survives the word reordering newsrooms actually do', () => {
  const a = 'Cyclone Remal makes landfall on the Odisha coast';
  const b = 'Landfall: Cyclone Remal hits the Odisha coast';
  assert.ok(
    headlineSimilarity(a, b) >= 0.55,
    'reordered syndication must stay one story — shingles alone score this ~0.25 and split it',
  );
  assert.ok(headlineSimilarity(a, 'Cyclone Remal makes landfall on the Odisha coast, thousands evacuated') >= 0.55);
  assert.ok(headlineSimilarity(a, 'Cyclone Remal landfall on Odisha coast; schools shut') >= 0.55);
});

test('headlineSimilarity keeps same-words-different-story pairs apart', () => {
  assert.ok(
    headlineSimilarity('Sensex closes higher', 'Sensex closes lower') < 0.55,
    'opposite outcomes sharing vocabulary are two stories',
  );
  assert.equal(headlineSimilarity('Cyclone hits Odisha', 'Reserve Bank holds repo rate'), 0);
  assert.equal(headlineSimilarity('', ''), 0);
});

test('clusterHeadlines groups syndicated copy and separates unrelated stories', () => {
  const items = [
    { title: 'Cyclone Remal makes landfall on Odisha coast' },
    { title: 'Cyclone Remal makes landfall on the Odisha coast, thousands evacuated' },
    { title: 'Landfall: Cyclone Remal hits Odisha coast' },
    { title: 'Sensex closes 400 points higher on banking gains' },
  ];
  const clusters = clusterHeadlines(items);
  assert.equal(clusters[0], clusters[1], 'near-identical headlines are one story');
  assert.notEqual(clusters[0], clusters[3], 'the markets story is its own');
  assert.equal(new Set(clusters).size >= 2, true);
});

test('clusterHeadlines is deterministic and handles degenerate input', () => {
  const items = [{ title: 'a b c d e' }, { title: 'a b c d e' }, { title: 'z y x w v' }];
  assert.deepEqual(clusterHeadlines(items), clusterHeadlines(items));
  assert.deepEqual(clusterHeadlines([]), []);
  assert.deepEqual(clusterHeadlines(null), []);
  assert.deepEqual(clusterHeadlines([{}, {}]), [0, 1], 'missing titles stay separate');
});

// ── Impact ─────────────────────────────────────────────────────────────────

test('coverageImpact bands on every threshold boundary', () => {
  assert.equal(coverageImpact(0), 1);
  assert.equal(coverageImpact(1), 1);
  assert.equal(coverageImpact(2), 2);
  assert.equal(coverageImpact(3), 3);
  assert.equal(coverageImpact(5), 3);
  assert.equal(coverageImpact(6), 4);
  assert.equal(coverageImpact(11), 4);
  assert.equal(coverageImpact(12), 5);
  assert.equal(coverageImpact(400), 5);
  assert.equal(coverageImpact(Number.NaN), 1);
  assert.equal(coverageImpact(-3), 1);
});

test('impactBand clamps out-of-range scores instead of returning undefined', () => {
  assert.equal(impactBand(5).label, 'CRITICAL');
  assert.equal(impactBand(1).label, 'MINOR');
  assert.equal(impactBand(9).label, 'CRITICAL');
  assert.equal(impactBand(0).label, 'MINOR');
  assert.equal(impactBand('nonsense').label, 'MINOR');
  for (const band of NEWS_IMPACT_BANDS) assert.match(band.color, /^#[0-9A-F]{6}$/i);
});

test('gradeByCoverage counts distinct outlets, not article copies', () => {
  const graded = gradeByCoverage([
    { title: 'Cyclone Remal makes landfall on Odisha coast', domain: 'a.com', url: 'https://a.com/1' },
    { title: 'Cyclone Remal makes landfall on Odisha coast today', domain: 'b.com', url: 'https://b.com/1' },
    { title: 'Cyclone Remal landfall on the Odisha coast', domain: 'c.com', url: 'https://c.com/1' },
    { title: 'Local council approves new parking scheme', domain: 'd.com', url: 'https://d.com/1' },
  ]);
  const cyclone = graded.filter((row) => row.domain !== 'd.com');
  assert.equal(new Set(cyclone.map((row) => row.clusterId)).size, 1);
  assert.equal(cyclone[0].distinctDomains, 3);
  assert.equal(cyclone[0].impact, 3);
  assert.equal(graded.at(-1).impact, 1, 'a single-outlet story is minor');
});

test('gradeByCoverage does not double-count one outlet republishing itself', () => {
  const graded = gradeByCoverage([
    { title: 'Parliament passes the finance bill', domain: 'same.com', url: 'https://same.com/1' },
    { title: 'Parliament passes the finance bill amid protests', domain: 'SAME.com', url: 'https://same.com/2' },
    { title: 'Parliament passes finance bill', domain: 'same.com', url: 'https://same.com/3' },
  ]);
  assert.equal(graded[0].clusterSize, 3);
  assert.equal(graded[0].distinctDomains, 1, 'case-folded to one publisher');
  assert.equal(graded[0].impact, 1);
});

test('gradeByCoverage is pure and total', () => {
  const input = [{ title: 'x y z', domain: 'a.com' }];
  const frozen = JSON.stringify(input);
  gradeByCoverage(input);
  assert.equal(JSON.stringify(input), frozen, 'input is not mutated');
  assert.deepEqual(gradeByCoverage([]), []);
  assert.deepEqual(gradeByCoverage(null), []);
  assert.equal(gradeByCoverage([{}])[0].impact, 1, 'no title and no domain still scores');
});

test('newsImpactLegend drops empty bands and keeps severity order', () => {
  const legend = newsImpactLegend({ 5: 2, 3: 7, 1: 0 });
  assert.deepEqual(legend.map((entry) => entry.label), ['CRITICAL', 'NOTABLE']);
  assert.equal(legend[0].count, 2);
  assert.deepEqual(newsImpactLegend({}), []);
  assert.deepEqual(newsImpactLegend(new Map([[4, 3]])).map((entry) => entry.label), ['MAJOR']);
});

// ── The fixture the thresholds were calibrated against ─────────────────────

test('the committed GDELT fixture grades to its documented shape', async () => {
  const { readFile } = await import('node:fs/promises');
  const url = new URL('./fixtures/gdelt-doc-artlist-synthetic.json', import.meta.url);
  const payload = JSON.parse(await readFile(url, 'utf8'));
  const graded = gradeByCoverage(payload.articles);

  const byDomains = new Map();
  for (const row of graded) {
    if (!byDomains.has(row.clusterId)) byDomains.set(row.clusterId, row);
  }
  const clusters = [...byDomains.values()]
    .map((row) => ({ domains: row.distinctDomains, impact: row.impact }))
    .sort((a, b) => b.domains - a.domains);

  assert.deepEqual(clusters.slice(0, 4), [
    { domains: 14, impact: 5 },
    { domains: 6, impact: 4 },
    { domains: 3, impact: 3 },
    { domains: 2, impact: 2 },
  ], 'a threshold change that regrades the fixture must be a deliberate, visible one');
  assert.ok(clusters.filter((c) => c.impact === 1).length >= 3, 'single-outlet stories stay minor');
});
