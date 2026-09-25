import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createNewsProxyMiddleware } from '../../vite.config.js';

/** Build a throwaway database with the ingester's schema and a few rows. */
function seedDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-news-'));
  const file = path.join(dir, 'news.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE news (
    id TEXT PRIMARY KEY, country TEXT NOT NULL, published_at TEXT NOT NULL, day TEXT NOT NULL,
    impact INTEGER NOT NULL, title TEXT NOT NULL, summary TEXT, source TEXT NOT NULL, url TEXT,
    lat REAL, lon REAL, distinct_domains INTEGER, graded_by TEXT NOT NULL, ingested_at TEXT NOT NULL);`);
  const insert = db.prepare('INSERT INTO news VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const rows = [
    ['in-2026-08-26-00000001', 'IN', '2026-08-26T01:00:00.000Z', '2026-08-26', 5, 'Critical story', null, 'a.com', 'https://a.com/1', null, null, 14],
    ['in-2026-08-26-00000002', 'IN', '2026-08-26T02:00:00.000Z', '2026-08-26', 3, 'Notable story', null, 'b.com', 'https://b.com/1', null, null, 4],
    ['in-2026-08-26-00000003', 'IN', '2026-08-26T03:00:00.000Z', '2026-08-26', 1, 'Minor story', null, 'c.com', 'https://c.com/1', null, null, 1],
    ['in-2026-08-27-00000004', 'IN', '2026-08-27T01:00:00.000Z', '2026-08-27', 4, 'Next day story', null, 'd.com', 'https://d.com/1', null, null, 7],
    ['us-2026-08-26-00000005', 'US', '2026-08-26T01:00:00.000Z', '2026-08-26', 5, 'Another country', null, 'e.com', 'https://e.com/1', null, null, 20],
  ];
  for (const row of rows) insert.run(...row, 'coverage-v1', '2026-08-27T00:00:00.000Z');
  db.close();
  return { dir, file };
}

/** Drive one request through a handler and capture the response. */
function call(handler, url, { method = 'GET' } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
      end(body) {
        if (body) chunks.push(body);
        let parsed = null;
        try { parsed = JSON.parse(chunks.join('')); } catch { /* not json */ }
        resolve({ status: this.statusCode, headers: this.headers, body: parsed, raw: chunks.join('') });
      },
    };
    handler({ method, url }, res, () => resolve({ status: 404, body: null, nexted: true }));
  });
}

const seeded = seedDatabase();
const api = createNewsProxyMiddleware({ dbPath: seeded.file });
test.after(() => {
  api.close();
  fs.rmSync(seeded.dir, { recursive: true, force: true });
});

test('serves a day, loudest first, with a deterministic order', async () => {
  const { status, body } = await call(api.handleNews, '/?country=IN&day=2026-08-26');
  assert.equal(status, 200);
  assert.equal(body.country, 'IN');
  assert.equal(body.day, '2026-08-26');
  assert.equal(body.total, 3);
  assert.equal(body.truncated, false);
  assert.deepEqual(body.items.map((i) => i.impact), [5, 3, 1], 'highest impact first');
  const item = body.items[0];
  assert.deepEqual(Object.keys(item).sort(), ['distinctDomains', 'id', 'impact', 'lat', 'lon', 'publishedAt', 'source', 'title', 'url']);
  assert.equal(item.distinctDomains, 14);
});

test('scopes strictly by country and day', async () => {
  const india = await call(api.handleNews, '/?country=IN&day=2026-08-26');
  assert.ok(india.body.items.every((i) => i.id.startsWith('in-2026-08-26')), 'no other country or day leaked in');
  const us = await call(api.handleNews, '/?country=US&day=2026-08-26');
  assert.equal(us.body.total, 1);
  const empty = await call(api.handleNews, '/?country=IN&day=2020-01-01');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.items, [], 'a day with no news is empty, not an error');
});

test('minImpact filters, and limit truncates honestly', async () => {
  const floor = await call(api.handleNews, '/?country=IN&day=2026-08-26&minImpact=3');
  assert.deepEqual(floor.body.items.map((i) => i.impact), [5, 3]);
  assert.equal(floor.body.total, 2);

  const capped = await call(api.handleNews, '/?country=IN&day=2026-08-26&limit=1');
  assert.equal(capped.body.count, 1);
  assert.equal(capped.body.total, 3);
  assert.equal(capped.body.truncated, true, 'must say so rather than silently cutting');
});

test('limit and minImpact are clamped, never trusted', async () => {
  const huge = await call(api.handleNews, '/?country=IN&day=2026-08-26&limit=999999');
  assert.equal(huge.status, 200);
  const zero = await call(api.handleNews, '/?country=IN&day=2026-08-26&limit=0');
  assert.equal(zero.body.count, 1, 'clamped up to 1');
  const silly = await call(api.handleNews, '/?country=IN&day=2026-08-26&minImpact=99');
  assert.equal(silly.body.minImpact, 5);
  const negative = await call(api.handleNews, '/?country=IN&day=2026-08-26&minImpact=-4');
  assert.equal(negative.body.minImpact, 1);
});

test('rejects malformed parameters before they reach SQLite', async () => {
  for (const query of [
    '/?day=2026-08-26',
    '/?country=INDIA&day=2026-08-26',
    '/?country=I1&day=2026-08-26',
    "/?country=IN'%20OR%201=1--&day=2026-08-26",
  ]) {
    const { status, body } = await call(api.handleNews, query);
    assert.equal(status, 400, `should reject ${query}`);
    assert.match(body.error, /country/);
  }
  for (const query of [
    '/?country=IN',
    '/?country=IN&day=2026-02-31',
    '/?country=IN&day=2026-8-26',
    '/?country=IN&day=yesterday',
  ]) {
    const { status, body } = await call(api.handleNews, query);
    assert.equal(status, 400, `should reject ${query}`);
    assert.match(body.error, /day/);
  }
});

test('a SQL injection attempt is treated as a bad country, not a query', async () => {
  const { status } = await call(api.handleNews, "/?country=IN&day=2026-08-26'; DROP TABLE news;--");
  assert.equal(status, 400);
  const after = await call(api.handleNews, '/?country=IN&day=2026-08-26');
  assert.equal(after.body.total, 3, 'the table is still there');
});

test('only GET is allowed, and nested paths are not swallowed', async () => {
  const post = await call(api.handleNews, '/?country=IN&day=2026-08-26', { method: 'POST' });
  assert.equal(post.status, 405);
  const nested = await call(api.handleNews, '/something-else?country=IN&day=2026-08-26');
  assert.equal(nested.nexted, true, 'passes through rather than answering');
});

test('the calendar reports days ascending with counts and peak impact', async () => {
  const { status, body } = await call(api.handleCalendar, '/?country=IN');
  assert.equal(status, 200);
  assert.deepEqual(body.days, [
    { day: '2026-08-26', count: 3, maxImpact: 5 },
    { day: '2026-08-27', count: 1, maxImpact: 4 },
  ]);
  const ranged = await call(api.handleCalendar, '/?country=IN&from=2026-08-27&to=2026-08-27');
  assert.deepEqual(ranged.body.days.map((d) => d.day), ['2026-08-27']);
  const bad = await call(api.handleCalendar, '/?country=IN&from=not-a-date');
  assert.equal(bad.status, 400);
});

test('a missing database is a legible 503 that leaks no path', async () => {
  const missing = createNewsProxyMiddleware({ dbPath: path.join(os.tmpdir(), 'gev-does-not-exist', 'news.sqlite') });
  const { status, body, raw } = await call(missing.handleNews, '/?country=IN&day=2026-08-26');
  assert.equal(status, 503);
  assert.equal(body.error, 'News database unavailable');
  assert.ok(!raw.includes('tmp'), 'the response must not carry a filesystem path');
  const calendar = await call(missing.handleCalendar, '/?country=IN');
  assert.equal(calendar.status, 503);
  missing.close();
});
