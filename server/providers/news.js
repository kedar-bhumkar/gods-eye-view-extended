/**
 * News provider — read-only SQLite reader over the locally ingested GDELT
 * database (`scripts/news-ingest.mjs`). Fork addition; moved here from the
 * pre-split vite.config.js unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * News middleware factory — reads the locally ingested SQLite database.
 *
 * Unlike every other proxy in this file there is no upstream and no secret:
 * `scripts/news-ingest.mjs` writes the database from GDELT, and this only
 * reads it. What it protects is not a key but the process — an untrusted query
 * string must never reach SQLite as anything but a bound value, and a missing
 * database must be a legible 503 rather than a stack trace carrying a
 * filesystem path.
 *
 * The handle is long-lived and reopened when the file's mtime moves, so the
 * scheduled ingest lands underneath a running dev server. SQLite reads are
 * microseconds, so there is deliberately no response cache — which also means
 * there is no stale-day bug to reason about.
 *
 *   GET /api/news?country=IN&day=2026-08-26&limit=200&minImpact=1
 *   GET /api/news/calendar?country=IN&from=2026-06-01&to=2026-08-27
 *
 * Exported for `src/data/newsProxy.test.mjs`, matching the radio/cctv pattern.
 * @param {object} [options] Test seams.
 * @param {string|null} [options.dbPath] Explicit database path, bypassing env.
 * @param {Record<string,string>} [options.env] Vite's loaded environment.
 * @returns {{handleNews: Function, handleCalendar: Function, close: Function}} Handlers.
 */
export function createNewsProxyMiddleware({ dbPath: dbPathOverride = null, env = {} } = {}) {
  const DEFAULT_LIMIT = 200;
  const MAX_LIMIT = 500;
  const MAX_CALENDAR_DAYS = 400;
  const COUNTRY_RE = /^[A-Z]{2}$/;
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

  let db = null;
  let openPath = '';
  let openMtime = 0;

  const resolveDbPath = () => path.resolve(
    dbPathOverride
    || env.NEWS_DB_PATH
    || process.env.NEWS_DB_PATH
    || path.join(process.cwd(), '.gev-cache', 'news.sqlite'),
  );

  function closeDb() {
    try { db?.close(); } catch { /* already closed */ }
    db = null;
    openPath = '';
    openMtime = 0;
  }

  /** Open read-only, reopening when the ingester has replaced the file. */
  function openDb() {
    const target = resolveDbPath();
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      closeDb();
      return null;
    }
    if (db && openPath === target && openMtime === stat.mtimeMs) return db;
    closeDb();
    try {
      db = new DatabaseSync(target, { readOnly: true });
      openPath = target;
      openMtime = stat.mtimeMs;
      return db;
    } catch (error) {
      console.warn('[news-proxy] could not open the news database:', error?.message || error);
      closeDb();
      return null;
    }
  }

  /** Validate an ISO 3166-1 alpha-2 code. Rejects; never coerces. */
  function readCountry(params) {
    const value = String(params.get('country') || '').trim().toUpperCase();
    return COUNTRY_RE.test(value) ? value : null;
  }

  /** Validate a YYYY-MM-DD day, rejecting calendar-impossible dates. */
  function readDay(params, key) {
    const value = String(params.get(key) || '').trim();
    if (!DAY_RE.test(value)) return null;
    const ms = Date.parse(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toISOString().slice(0, 10) === value ? value : null;
  }

  const send = (res, status, payload) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(payload));
  };

  function handleCalendar(req, res) {
    if (req.method !== 'GET') { send(res, 405, { error: 'Method Not Allowed' }); return; }
    const params = new URL(req.url || '', 'http://localhost').searchParams;
    const country = readCountry(params);
    if (!country) { send(res, 400, { error: 'country must be an ISO 3166-1 alpha-2 code' }); return; }
    if ((params.get('from') && !readDay(params, 'from')) || (params.get('to') && !readDay(params, 'to'))) {
      send(res, 400, { error: 'from/to must be a valid YYYY-MM-DD date' });
      return;
    }
    const handle = openDb();
    if (!handle) { send(res, 503, { error: 'News database unavailable' }); return; }

    const from = readDay(params, 'from');
    const to = readDay(params, 'to');
    try {
      const clauses = ['country = ?'];
      const binds = [country];
      if (from) { clauses.push('day >= ?'); binds.push(from); }
      if (to) { clauses.push('day <= ?'); binds.push(to); }
      const rows = handle.prepare(
        `SELECT day, COUNT(*) AS count, MAX(impact) AS maxImpact
           FROM news WHERE ${clauses.join(' AND ')}
          GROUP BY day ORDER BY day DESC LIMIT ${MAX_CALENDAR_DAYS}`,
      ).all(...binds);
      rows.reverse();
      send(res, 200, { country, days: rows, truncated: rows.length >= MAX_CALENDAR_DAYS });
    } catch (error) {
      console.warn('[news-proxy] calendar query failed:', error?.message || error);
      send(res, 500, { error: 'News calendar query failed' });
    }
  }

  function handleNews(req, res, next) {
    // Connect matches by prefix and the calendar route is registered first, so
    // only bare /api/news arrives here. Anything nested is someone else's.
    const pathname = new URL(req.url || '', 'http://localhost').pathname;
    if (pathname !== '/' && pathname !== '') {
      if (typeof next === 'function') next();
      else send(res, 404, { error: 'Not Found' });
      return;
    }
    if (req.method !== 'GET') { send(res, 405, { error: 'Method Not Allowed' }); return; }

    const params = new URL(req.url || '', 'http://localhost').searchParams;
    const country = readCountry(params);
    if (!country) { send(res, 400, { error: 'country must be an ISO 3166-1 alpha-2 code' }); return; }
    const day = readDay(params, 'day');
    if (!day) { send(res, 400, { error: 'day must be a valid YYYY-MM-DD date' }); return; }

    const requestedLimit = Number.parseInt(String(params.get('limit') ?? ''), 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(MAX_LIMIT, Math.max(1, requestedLimit))
      : DEFAULT_LIMIT;
    const requestedFloor = Number.parseInt(String(params.get('minImpact') ?? ''), 10);
    const minImpact = Number.isFinite(requestedFloor) ? Math.min(5, Math.max(1, requestedFloor)) : 1;

    const handle = openDb();
    if (!handle) { send(res, 503, { error: 'News database unavailable' }); return; }

    try {
      const total = handle.prepare(
        'SELECT COUNT(*) AS c FROM news WHERE country = ? AND day = ? AND impact >= ?',
      ).get(country, day, minImpact).c;

      // Deterministic ordering: loudest first, id as the tie-break, so the same
      // request always returns the same rows in the same order — which is what
      // makes a share link show the sender's map rather than a similar one.
      const items = handle.prepare(
        `SELECT id, title, source, url, impact, published_at AS publishedAt,
                distinct_domains AS distinctDomains, lat, lon
           FROM news
          WHERE country = ? AND day = ? AND impact >= ?
          ORDER BY impact DESC, distinct_domains DESC, id ASC
          LIMIT ?`,
      ).all(country, day, minImpact, limit);

      send(res, 200, {
        country, day, minImpact, count: items.length, total, truncated: total > items.length, items,
      });
    } catch (error) {
      console.warn('[news-proxy] query failed:', error?.message || error);
      send(res, 500, { error: 'News query failed' });
    }
  }

  return { handleNews, handleCalendar, close: closeDb };
}

/**
 * Vite plugin wrapper around {@link createNewsProxyMiddleware}.
 * @param {Record<string,string>} env Vite's loaded environment.
 * @returns {import('vite').Plugin} The plugin.
 */
export function newsProxy(env = process.env) {
  const api = createNewsProxyMiddleware({ env });
  const install = (middlewares) => {
    // Calendar first: Connect matches by prefix, and /api/news would otherwise
    // swallow /api/news/calendar.
    middlewares.use('/api/news/calendar', api.handleCalendar);
    middlewares.use('/api/news', api.handleNews);
  };
  return {
    name: 'news-proxy',
    configureServer(server) { install(server.middlewares); },
    configurePreviewServer(server) { install(server.middlewares); },
    closeBundle() { api.close(); },
  };
}
