#!/usr/bin/env node
/**
 * Ingest GDELT DOC 2.0 article lists into the local News SQLite database.
 *
 * Source:   https://api.gdeltproject.org/api/v2/doc/doc  (no API key required)
 * License:  GDELT is free for unlimited academic, commercial or governmental
 *           use; any use or redistribution must cite the GDELT Project and
 *           link to https://gdeltproject.org/ — see DATA_SOURCES.md.
 *
 * One HTTP call per country-day. Impact is graded here, once, from how many
 * distinct outlets carried the same story (`newsPolicy.gradeByCoverage`) — the
 * proxy and the layer only ever read the number.
 *
 * Idempotent by construction: the primary key is derived from country + day +
 * canonical URL, so overlapping windows, re-runs and backfills upsert rather
 * than duplicate. That is what lets a missed scheduled run heal itself on the
 * next one, with no cursor or state file to keep.
 *
 * Usage:
 *   node scripts/news-ingest.mjs                        # trailing 2 days, IN
 *   node scripts/news-ingest.mjs --country=US --days=3
 *   node scripts/news-ingest.mjs --country=IN --from=2026-06-01 --to=2026-08-26
 *   node scripts/news-ingest.mjs --fixture=sample.json --day=2026-08-24
 *   node scripts/news-ingest.mjs --dry-run --verbose
 *   node scripts/news-ingest.mjs --diagnose            # why is the network failing?
 *
 * Options:
 *   --country=XX        ISO 3166-1 alpha-2 stored in the database (default IN)
 *   --gdelt-country=XX  what to send to GDELT, if it differs from the ISO code
 *   --lang=english      GDELT sourcelang (default english)
 *   --days=N            trailing window ending today, inclusive (default 2)
 *   --from= --to=       explicit YYYY-MM-DD range; overrides --days
 *   --day=              a single YYYY-MM-DD
 *   --db=PATH           SQLite path (default NEWS_DB_PATH, else .gev-cache/news.sqlite)
 *   --max=N             records per WINDOW, GDELT caps this at 250 (default 250)
 *   --slice-hours=N     hours per request window (default 2 → 12 requests/day).
 *                       One request per day returns ~1% of a country's news and
 *                       cannot see syndication; use 1 for the widest coverage.
 *   --sort=             datedesc (default) | dateasc | tonedesc | toneasc | hybridrel
 *   --fixture=PATH      read a saved GDELT JSON response instead of the network
 *   --dry-run           fetch and grade, write nothing
 *   --verbose           print every row
 *   --self-test         run every code path offline, failure paths included
 *   --save-response=DIR save raw upstream JSON as fixtures (default .gev-cache/gdelt-raw)
 *   --diagnose          probe DNS, TCP, TLS and HTTP to GDELT and report where it stops
 *   --timeout=SECONDS   per-request timeout covering connect and read (default 45)
 *   --allow-http        fetch over plain HTTP when HTTPS is blocked on your network.
 *                       GDELT is public data and this script sends no credentials,
 *                       so nothing confidential crosses the wire either way.
 *
 * @module scripts/news-ingest
 */

import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  NEWS_GRADER_ID,
  canonicalArticleUrl,
  dayKeyFromMs,
  dayKeyRange,
  gdeltDayWindows,
  gradeByCoverage,
  normalizeCountryCode,
  normalizeDayKey,
  parseGdeltSeenDate,
  stableArticleId,
  tidyHeadline,
} from '../src/data/newsPolicy.js';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GDELT_ENDPOINT = 'https://api.gdeltproject.org/api/v2/doc/doc';
/** GDELT's hard ceiling for artlist mode. Asking for more is silently capped. */
const GDELT_MAX_RECORDS = 250;
/** Gap between country-day requests. GDELT publishes about how sensitive their
 *  quota is to sustained QPS; one request per second and a bit is neighbourly. */
const REQUEST_SPACING_MS = 1_200;
let requestTimeoutMs = 45_000;
const MAX_ATTEMPTS = 4;
const DEFAULT_DB_RELATIVE = path.join('.gev-cache', 'news.sqlite');

/**
 * GDELT reports several conditions with HTTP 200 and a short plain-text body.
 * These are deterministic: the same request will fail the same way forever, so
 * retrying is pure waste and the window should simply be skipped.
 */
const GDELT_PERMANENT_ERRORS = Object.freeze([
  'invalid query start date',
  'invalid query end date',
  'timespan is too short',
  'your query was too short',
]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS news (
  id               TEXT PRIMARY KEY,
  country          TEXT NOT NULL,
  published_at     TEXT NOT NULL,
  day              TEXT NOT NULL,
  impact           INTEGER NOT NULL,
  title            TEXT NOT NULL,
  summary          TEXT,
  source           TEXT NOT NULL,
  url              TEXT,
  lat              REAL,
  lon              REAL,
  distinct_domains INTEGER,
  graded_by        TEXT NOT NULL,
  ingested_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS news_country_day ON news (country, day);
CREATE INDEX IF NOT EXISTS news_country_day_impact ON news (country, day, impact DESC);
`;

const UPSERT = `
INSERT INTO news (
  id, country, published_at, day, impact, title, summary, source, url,
  lat, lon, distinct_domains, graded_by, ingested_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  impact           = excluded.impact,
  title            = excluded.title,
  summary          = COALESCE(excluded.summary, news.summary),
  distinct_domains = excluded.distinct_domains,
  graded_by        = excluded.graded_by,
  ingested_at      = excluded.ingested_at,
  lat              = COALESCE(news.lat, excluded.lat),
  lon              = COALESCE(news.lon, excluded.lon)
`;

/**
 * Parse `--key=value` and `--flag` arguments into a plain options object.
 * @param {string[]} argv Raw arguments (without node and script path).
 * @returns {Record<string, string|boolean>} Parsed options.
 */
function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const options = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) options[body] = true;
    else options[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return options;
}

/** Print to stderr so stdout stays clean for anything that pipes this. */
function log(...parts) {
  process.stderr.write(`${parts.join(' ')}\n`);
}

/** Resolve NEWS_DB_PATH from the CLI, the environment, then .env, then default. */
async function resolveDbPath(options) {
  if (typeof options.db === 'string' && options.db) return path.resolve(options.db);
  if (process.env.NEWS_DB_PATH) return path.resolve(process.env.NEWS_DB_PATH);
  try {
    const { readDotenvValue } = await import('./read-dotenv-value.mjs');
    const fromFile = readDotenvValue('NEWS_DB_PATH', REPO_ROOT);
    if (fromFile) return path.resolve(REPO_ROOT, fromFile);
  } catch {
    // vite (and therefore the repo's dotenv reader) is not installed — fine,
    // the default below keeps the script usable on a bare checkout.
  }
  return path.join(REPO_ROOT, DEFAULT_DB_RELATIVE);
}

/**
 * Open the database, creating the schema and enabling WAL.
 *
 * WAL matters operationally: the dev-server proxy holds a long-lived read-only
 * handle on this file, and WAL is what lets this write land underneath it
 * instead of colliding with SQLITE_BUSY.
 * @param {string} dbPath Absolute path to the SQLite file.
 * @returns {DatabaseSync} Open handle with the schema applied.
 */
function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // Best-effort, not fatal: WAL needs shared memory the underlying filesystem
  // may not provide (network shares, FUSE mounts, some synced folders). The
  // ingester still works without it; concurrent reads from the dev-server
  // proxy just fall back to the rollback journal's locking.
  try {
    db.exec('PRAGMA journal_mode = WAL;');
  } catch (error) {
    log(`[news-ingest] warning: WAL unavailable on this filesystem (${error.message}); using the default journal.`);
  }
  db.exec(SCHEMA);
  return db;
}

/** Build the DOC 2.0 request URL for one time window. */
function gdeltUrl({ gdeltCountry, lang, window, maxRecords, sort = 'datedesc', allowHttp = false }) {
  const params = new URLSearchParams({
    query: `sourcecountry:${gdeltCountry} sourcelang:${lang}`,
    mode: 'artlist',
    format: 'json',
    maxrecords: String(maxRecords),
    startdatetime: window.start,
    enddatetime: window.end,
    // datedesc, not hybridrel: with no search terms there is nothing to rank
    // relevance against, and the first live run showed relevance ordering
    // collapsing onto a single media group. Date ordering inside a narrow
    // window gives every publisher an equal chance of being in the 250.
    sort,
  });
  const endpoint = allowHttp ? GDELT_ENDPOINT.replace('https://', 'http://') : GDELT_ENDPOINT;
  return `${endpoint}?${params}`;
}

/**
 * Unwrap Node's opaque `fetch failed` into the chain that actually explains it.
 *
 * undici reports every transport problem — DNS, TLS, refused, timed out — as
 * the same two words, and puts the real reason in `error.cause`, sometimes
 * nested two deep. Printing only the top message turns a five-second fix into
 * an afternoon, so the whole chain is surfaced.
 * @param {*} error Caught value.
 * @returns {string} e.g. `fetch failed <- getaddrinfo ENOTFOUND ... (ENOTFOUND)`.
 */
function describeFetchError(error) {
  const parts = [];
  const seen = new Set();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const message = String(current.message ?? '').trim();
    if (message) parts.push(current.code ? `${message} (${current.code})` : message);
    current = current.cause;
  }
  if (!parts.length) parts.push(String(error ?? 'unknown error'));
  return parts.join(' <- ');
}

/**
 * Turn a transport failure into the one sentence that names the likely fix.
 * @param {*} error Caught value.
 * @returns {string} Advice, or an empty string when nothing specific applies.
 */
function fetchHint(error) {
  const chain = describeFetchError(error).toLowerCase();
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (/enotfound|eai_again/.test(chain)) {
    return 'DNS could not resolve api.gdeltproject.org. Check your resolver, VPN, or DNS-level blocker.';
  }
  if (/certificate|self.signed|unable_to_verify|cert_/.test(chain)) {
    return "TLS is being intercepted (corporate proxy or antivirus). Export that root CA and point NODE_EXTRA_CA_CERTS at it.";
  }
  if (/econnrefused/.test(chain)) return 'The connection was refused — a local firewall, or a proxy expecting to be used.';
  if (/etimedout|timeout|und_err_connect_timeout|headers timeout/.test(chain)) {
    return proxy
      ? `Timed out, and a proxy is configured (${proxy}). Node's fetch ignores proxy env vars unless NODE_USE_ENV_PROXY=1 (Node 24+).`
      : 'Timed out before the connection opened. Run --diagnose: it separates an MTU black hole from SNI filtering, and --allow-http works around the latter.';
  }
  if (/econnreset|socket hang up/.test(chain)) return 'The connection was reset mid-flight — often a proxy or filtering appliance.';
  if (/no response within|gev_timeout/.test(chain)) {
    return 'The host accepted nothing in time. Your --diagnose run measured 3,034ms to connect on 443 versus 26ms on port 80 — try --allow-http, or raise --timeout.';
  }
  if (proxy) return `A proxy is configured (${proxy}); Node's fetch ignores proxy env vars unless NODE_USE_ENV_PROXY=1 is set (Node 24+).`;
  return '';
}

/**
 * Hosts probed by --diagnose. The control host is the load-bearing one: if it
 * opens and the GDELT hosts do not, the block is specific to GDELT rather than
 * to this machine's outbound traffic.
 */
const DIAGNOSTIC_PROBES = Object.freeze([
  Object.freeze({ host: 'api.gdeltproject.org', port: 443, role: 'the API this script calls' }),
  Object.freeze({ host: 'api.gdeltproject.org', port: 80, role: 'same host, plain HTTP' }),
  Object.freeze({ host: 'data.gdeltproject.org', port: 443, role: 'GDELT bulk files' }),
  Object.freeze({ host: 'www.google.com', port: 443, role: 'control - unrelated host' }),
]);

/**
 * Open a bare TCP connection and report whether it completes.
 * @param {string} host Hostname.
 * @param {number} port Port.
 * @param {number} [timeoutMs] Give-up time.
 * @returns {Promise<{ok:boolean, detail:string}>} Outcome.
 */
function probeTcp(host, port, timeoutMs = 8_000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port, timeout: timeoutMs });
    const settle = (ok, detail) => { socket.destroy(); resolve({ ok, detail }); };
    socket.on('connect', () => settle(true, `${Date.now() - started}ms`));
    socket.on('timeout', () => settle(false, `timed out after ${timeoutMs}ms — packets dropped, not refused`));
    socket.on('error', (error) => settle(false, describeFetchError(error)));
  });
}

/**
 * Complete a TLS handshake and report how long it took and who signed the
 * certificate. Separating this from the TCP probe is what distinguishes an
 * MTU black hole (TCP opens, every TLS handshake stalls) from SNI filtering
 * (TCP opens, only the filtered hostname's handshake stalls).
 * @param {string} host Hostname.
 * @param {number} [timeoutMs] Give-up time.
 * @returns {Promise<{ok:boolean, detail:string}>} Outcome.
 */
function probeTls(host, timeoutMs = 12_000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = tls.connect({ host, port: 443, servername: host, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      const issuer = cert?.issuer?.O || cert?.issuer?.CN || '(unknown)';
      const publicCa = /google|goog|let's encrypt|digicert|amazon|cloudflare|sectigo|isrg|globalsign/i.test(String(issuer));
      socket.destroy();
      resolve({
        ok: true,
        detail: `${Date.now() - started}ms  issuer=${issuer}${publicCa ? '' : '  <- NOT a public CA: TLS is being intercepted'}`,
      });
    });
    socket.on('timeout', () => { socket.destroy(); resolve({ ok: false, detail: `handshake timed out after ${timeoutMs}ms` }); });
    socket.on('error', (error) => { socket.destroy(); resolve({ ok: false, detail: describeFetchError(error) }); });
  });
}

/**
 * Probe the network path to GDELT one layer at a time — DNS, then raw TCP,
 * then the TLS handshake, then HTTP over both schemes — and end with a verdict
 * naming the likely culprit.
 * @returns {Promise<void>}
 */
async function diagnose() {
  const target = new URL(GDELT_ENDPOINT).hostname;
  log(`[diagnose] node ${process.versions.node} on ${process.platform} ${process.arch}`);
  const envVars = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS']
    .filter((name) => process.env[name])
    .map((name) => `${name}=${process.env[name]}`);
  log(`[diagnose] proxy/TLS env: ${envVars.length ? envVars.join('  ') : '(none set)'}`);

  for (const host of [...new Set(DIAGNOSTIC_PROBES.map((probe) => probe.host))]) {
    try {
      const addresses = await dns.lookup(host, { all: true });
      log(`[diagnose] DNS   OK    ${host.padEnd(22)} -> ${addresses.map((a) => a.address).join(', ')}`);
    } catch (error) {
      log(`[diagnose] DNS   FAIL  ${host.padEnd(22)} ${describeFetchError(error)}`);
    }
  }

  /** @type {Map<string, boolean>} */
  const reachable = new Map();
  for (const probe of DIAGNOSTIC_PROBES) {
    const key = `${probe.host}:${probe.port}`;
    const result = await probeTcp(probe.host, probe.port);
    reachable.set(key, result.ok);
    log(`[diagnose] TCP   ${result.ok ? 'OK  ' : 'FAIL'}  ${key.padEnd(28)} ${result.detail}  (${probe.role})`);
  }

  /** @type {Map<string, {ok:boolean, detail:string}>} */
  const tlsResults = new Map();
  for (const probe of DIAGNOSTIC_PROBES.filter((entry) => entry.port === 443)) {
    if (!reachable.get(`${probe.host}:443`)) continue;
    const result = await probeTls(probe.host);
    tlsResults.set(probe.host, result);
    log(`[diagnose] TLS   ${result.ok ? 'OK  ' : 'FAIL'}  ${probe.host.padEnd(28)} ${result.detail}`);
  }

  const httpsProbe = `${GDELT_ENDPOINT}?query=sourcecountry:IN&mode=artlist&format=json&maxrecords=1&timespan=1d`;
  for (const [scheme, url] of [['HTTPS', httpsProbe], ['HTTP ', httpsProbe.replace('https://', 'http://')]]) {
    try {
      const started = Date.now();
      const response = await httpGet(url);
      const body = response.body;
      log(`[diagnose] ${scheme} OK    ${response.status} ${response.headers['content-type'] || ''} ${body.length} bytes in ${Date.now() - started}ms`);
      log(`[diagnose]             body starts: ${body.trim().slice(0, 110).replace(/\s+/g, ' ')}`);
    } catch (error) {
      log(`[diagnose] ${scheme} FAIL  ${describeFetchError(error)}`);
    }
  }

  const controlTls = tlsResults.get('www.google.com')?.ok;
  const apiTls = tlsResults.get(target)?.ok;
  const bulkTls = tlsResults.get('data.gdeltproject.org')?.ok;
  log('[diagnose] ---');
  if (apiTls) {
    log('[diagnose] verdict: TLS to the API host completes. Any remaining failure is at the HTTP layer.');
  } else if (controlTls === false) {
    log('[diagnose] verdict: TLS fails to the control host too, though plain TCP opened everywhere.');
    log('[diagnose]          That is an MTU black hole: small packets pass, the large TLS handshake does not.');
    log('[diagnose]          Try: netsh interface ipv4 set subinterface "Wi-Fi" mtu=1400 store=persistent');
  } else if (controlTls && bulkTls === false) {
    log('[diagnose] verdict: TLS works to unrelated hosts but not to either GDELT host, while plain TCP opens to both.');
    log('[diagnose]          That is SNI-based filtering: something reads the hostname from the TLS hello and drops it.');
  } else if (controlTls && bulkTls) {
    log('[diagnose] verdict: TLS works everywhere except the API host. That host is down or separately filtered;');
    log('[diagnose]          the bulk host still works, so the Events 2.0 path stays open.');
  }
  if (apiTls === false) {
    log('[diagnose] If the HTTP line above succeeded, re-run the ingester with --allow-http to use port 80.');
    log('[diagnose] GDELT is public data and this script sends no credentials, so there is nothing to intercept.');
  }
}

/**
 * Keep-alive agents, one socket each.
 *
 * This is not a micro-optimisation, it is the fix. Connecting to
 * api.gdeltproject.org:443 was measured at 3,034 ms from the machine this was
 * built for, against 26 ms to port 80 on the same host. A day sliced into 24
 * windows pays that connect cost 24 times over, and any one of them drifting
 * past the ceiling fails the window. One reused connection pays it once.
 */
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 30_000 });
const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 30_000 });

/**
 * GET a URL over node:http(s) rather than global fetch.
 *
 * fetch is undici, and undici applies its own 10-second connect timeout that
 * an AbortSignal passed to fetch does not govern — which is why a 30-second
 * signal still produced UND_ERR_CONNECT_TIMEOUT at exactly 10,000 ms. Going
 * through node:https gives one timeout that actually covers connecting, and a
 * keep-alive agent besides.
 * @param {string} url Absolute URL.
 * @param {object} [options] Request options.
 * @param {number} [options.timeoutMs] Socket timeout covering connect and idle.
 * @returns {Promise<{status:number, headers:object, body:string}>} Response.
 */
function httpGet(url, { timeoutMs = requestTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    const plain = target.protocol === 'http:';
    const transport = plain ? http : https;
    const request = transport.get(url, {
      agent: plain ? keepAliveHttp : keepAliveHttps,
      timeout: timeoutMs,
      headers: {
        'user-agent': 'gods-eye-view/news-ingest (+https://github.com/bilawalsidhu/gods-eye-view)',
        'accept-encoding': 'identity',
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        // A connection that closes early yields a short body and no error. Left
        // undetected it surfaces later as an unexplained JSON parse failure —
        // one of the 48 captured windows was a 156 KB truncated response.
        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && buffer.length < declared) {
          reject(Object.assign(
            new Error(`truncated response: ${buffer.length} of ${declared} bytes`),
            { code: 'GEV_TRUNCATED' },
          ));
          return;
        }
        resolve({ status: response.statusCode, headers: response.headers, body: buffer.toString('utf8') });
      });
      response.on('error', reject);
    });
    request.on('timeout', () => {
      request.destroy(Object.assign(
        new Error(`no response within ${timeoutMs}ms (connect or read)`),
        { code: 'GEV_TIMEOUT' },
      ));
    });
    request.on('error', reject);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch one country-day from GDELT, retrying transient failures.
 *
 * GDELT answers a malformed or over-quota query with HTTP 200 and a plain-text
 * body, so a JSON parse failure is treated as an upstream error and its first
 * line is surfaced verbatim rather than swallowed.
 * @param {object} request Request description, including one time `window`.
 * @returns {Promise<Array<object>>} Raw GDELT article records.
 */
async function fetchGdeltWindow(request) {
  const url = gdeltUrl(request);
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await httpGet(url);
      const body = response.body;
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`upstream HTTP ${response.status}`);
      }
      if (response.status < 200 || response.status >= 300) {
        throw Object.assign(new Error(`upstream HTTP ${response.status}: ${body.slice(0, 160)}`), { fatal: true });
      }
      const trimmed = body.trim();
      const permanent = trimmed.length < 200
        && GDELT_PERMANENT_ERRORS.some((message) => trimmed.toLowerCase().startsWith(message));
      if (permanent) {
        throw Object.assign(new Error(`GDELT refused the window: ${trimmed}`), { fatal: true, permanent: true });
      }
      if (request.saveResponse && trimmed.startsWith('{')) {
        // Capture the raw upstream body. One real capture turns every future
        // change to the parser, the clustering and the thresholds into an
        // offline exercise instead of a round trip through a live network.
        try {
          fs.mkdirSync(request.saveResponse, { recursive: true });
          const name = `gdelt-${request.gdeltCountry}-${request.window.start}-${request.window.end}.json`;
          fs.writeFileSync(path.join(request.saveResponse, name), body, 'utf8');
        } catch (writeError) {
          log(`    warning: could not save response — ${writeError.message}`);
        }
      }
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        const detail = body.trim().split('\n')[0].slice(0, 200) || '(empty body)';
        throw new Error(`non-JSON response: ${detail}`);
      }
      return Array.isArray(payload?.articles) ? payload.articles : [];
    } catch (error) {
      lastError = error;
      if (error?.fatal || attempt === MAX_ATTEMPTS) break;
      const backoff = Math.round(800 * 2 ** (attempt - 1) * (1 + Math.random() * 0.3));
      log(`  retry ${attempt}/${MAX_ATTEMPTS - 1} in ${backoff}ms — ${describeFetchError(error)}`);
      await sleep(backoff);
    }
  }
  throw lastError || new Error('GDELT request failed');
}

/**
 * Fetch a whole day as a series of time windows, de-duplicated.
 *
 * Grading happens on the merged day, never per window — syndication is only
 * visible across the whole day, and a story that broke at 09:00 is carried by
 * other outlets at 11:00.
 * @param {string} day UTC day key.
 * @param {object} options Request options including sliceHours.
 * @returns {Promise<{articles: Array<object>, windows: number, failed: number}>} Merged result.
 */
async function fetchGdeltDay(day, options) {
  const windows = gdeltDayWindows(day, options.sliceHours);
  const seen = new Set();
  const articles = [];
  let failed = 0;
  for (const [index, window] of windows.entries()) {
    try {
      const batch = await fetchGdeltWindow({ ...options, window });
      for (const article of batch) {
        const key = canonicalArticleUrl(article?.url);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        articles.push(article);
      }
      if (options.verbose) log(`    window ${window.start.slice(8, 12)}-${window.end.slice(8, 12)}  ${batch.length} records`);
    } catch (error) {
      // A single bad window loses an hour, not the day. The upsert is
      // idempotent, so the next scheduled run refills it.
      failed++;
      log(`    window ${window.start.slice(8, 12)}-${window.end.slice(8, 12)}  FAILED — ${describeFetchError(error)}`);
    }
    if (index < windows.length - 1) await sleep(REQUEST_SPACING_MS);
  }
  if (failed === windows.length) throw new Error(`all ${windows.length} windows failed`);
  return { articles, windows: windows.length, failed };
}

/** Read a saved GDELT response instead of the network. */
function readFixture(fixturePath) {
  const payload = JSON.parse(fs.readFileSync(path.resolve(fixturePath), 'utf8'));
  return Array.isArray(payload?.articles) ? payload.articles : [];
}

/**
 * Map one graded GDELT record onto a database row.
 *
 * Returns null for anything missing an id-able URL, a title or a publisher —
 * a row that cannot be identified cannot be upserted idempotently, and a
 * headline-less pin has nothing to say.
 * @param {object} article Graded GDELT record.
 * @param {string} country ISO alpha-2 code.
 * @param {string} day UTC day key.
 * @param {string} ingestedAt ISO timestamp for this run.
 * @returns {Array<*>|null} Bind values for UPSERT, in column order.
 */
function toRow(article, country, day, ingestedAt) {
  const url = String(article?.url ?? '').trim();
  const title = tidyHeadline(article?.title);
  const source = String(article?.domain ?? '').trim().toLowerCase();
  const publishedAt = parseGdeltSeenDate(article?.seendate) || `${day}T00:00:00.000Z`;
  // The article belongs to the day GDELT saw it, NOT the window that happened
  // to return it. GDELT buckets seendate to 15-minute marks, so an article seen
  // at 23:59 is stamped 00:00:00 the next day and is returned by BOTH day N's
  // last window and day N+1's first. Keying the id off the fetching window
  // minted two ids for one article — measured at 50 of 6,502 rows on the first
  // real run, each showing as two pins in two different places.
  const actualDay = normalizeDayKey(publishedAt.slice(0, 10)) || day;
  const id = stableArticleId(country, actualDay, url);
  if (!id || !title || !source) return null;
  return [
    id,
    country,
    publishedAt,
    actualDay,
    article.impact,
    title,
    null,
    source,
    url,
    null,
    null,
    article.distinctDomains ?? null,
    NEWS_GRADER_ID,
    ingestedAt,
  ];
}

/**
 * Fetch, grade and write one country-day.
 * @returns {Promise<{fetched:number,written:number,skipped:number,tally:Record<number,number>}>} Per-day counts.
 */
async function ingestDay(db, country, day, options) {
  const fetched = options.fixture
    ? { articles: readFixture(options.fixture), windows: 1, failed: 0 }
    : await fetchGdeltDay(day, options);
  const raw = fetched.articles;
  const graded = gradeByCoverage(raw);
  const ingestedAt = new Date().toISOString();
  /** @type {Record<number, number>} */
  const tally = {};
  let written = 0;
  let skipped = 0;

  const rows = [];
  for (const article of graded) {
    const row = toRow(article, country, day, ingestedAt);
    if (!row) { skipped++; continue; }
    rows.push(row);
    tally[article.impact] = (tally[article.impact] || 0) + 1;
    if (options.verbose) log(`    [${article.impact}] ${article.domain} — ${String(article.title).slice(0, 78)}`);
  }

  if (!options['dry-run'] && rows.length) {
    const statement = db.prepare(UPSERT);
    db.exec('BEGIN');
    try {
      for (const row of rows) { statement.run(...row); written++; }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  // Publisher count is the canary. The first live run wrote 500 rows from 8
  // publishers, all one media group, and every story graded 1 because nothing
  // could cluster. A row count alone looked healthy; this number did not.
  const publishers = new Set(rows.map((row) => row[7])).size;
  return { fetched: raw.length, written, skipped, tally, publishers, windows: fetched.windows, failedWindows: fetched.failed };
}

/** Format a per-impact tally as `5×2 4×1 3×7`, highest band first. */
function formatTally(tally) {
  const parts = [5, 4, 3, 2, 1].filter((impact) => tally[impact]).map((impact) => `${impact}×${tally[impact]}`);
  return parts.length ? parts.join(' ') : 'none';
}

/**
 * Exercise every code path this script has, offline, including the ones that
 * only run when something goes wrong.
 *
 * This exists because of a real failure: an edit deleted `describeFetchError`,
 * `node --check` passed (an undefined function is valid syntax until called),
 * the fixture run passed (it never fails, so the error path never executed),
 * and the break only surfaced on a live run at the exact moment the error
 * handling was needed. Syntax checks and happy-path runs do not prove a
 * script works; running the failure path does.
 * @returns {Promise<boolean>} True when every check passed.
 */
async function selfTest() {
  const results = [];
  const check = (name, fn) => {
    try {
      const detail = fn();
      results.push({ name, ok: true, detail: detail || '' });
    } catch (error) {
      results.push({ name, ok: false, detail: error.message });
    }
  };

  check('url building', () => {
    const url = gdeltUrl({
      gdeltCountry: 'IN', lang: 'english', maxRecords: 250, sort: 'datedesc',
      window: gdeltDayWindows('2026-08-24', 1)[9],
    });
    if (!url.includes('startdatetime=20260824090000')) throw new Error(`window not applied: ${url}`);
    if (!url.startsWith('https://')) throw new Error('should default to https');
    const plain = gdeltUrl({
      gdeltCountry: 'IN', lang: 'english', maxRecords: 250, allowHttp: true,
      window: gdeltDayWindows('2026-08-24', 24)[0],
    });
    if (!plain.startsWith('http://')) throw new Error('--allow-http not honoured');
    return '24 windows, https + http variants';
  });

  check('error unwrapping (the path that once crashed)', () => {
    const nested = new Error('fetch failed');
    nested.cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.gdeltproject.org'), { code: 'ENOTFOUND' });
    const described = describeFetchError(nested);
    if (!described.includes('ENOTFOUND')) throw new Error(`cause not unwrapped: ${described}`);
    if (!describeFetchError(null)) throw new Error('null input must still describe something');
    return described;
  });

  check('failure hints', () => {
    const timeout = Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
    if (!fetchHint(timeout)) throw new Error('a connect timeout should produce advice');
    const tlsError = Object.assign(new Error('fetch failed'), { cause: new Error('unable to verify the first certificate') });
    if (!/NODE_EXTRA_CA_CERTS/.test(fetchHint(tlsError))) throw new Error('TLS interception should name the fix');
    return 'timeout + TLS interception recognised';
  });

  check('row mapping rejects what it cannot identify', () => {
    const at = '2026-08-24T00:00:00.000Z';
    const good = toRow({ url: 'https://a.com/x', title: 'T', domain: 'a.com', seendate: '20260824T090000Z', impact: 3, distinctDomains: 4 }, 'IN', '2026-08-24', at);
    if (!good || good[0] !== stableArticleId('IN', '2026-08-24', 'https://a.com/x')) throw new Error('good row mismapped');
    if (good[2] !== '2026-08-24T09:00:00.000Z') throw new Error('seendate not parsed');
    for (const bad of [{ url: '', title: 'T', domain: 'a.com' }, { url: 'https://a.com/x', title: '', domain: 'a.com' }, { url: 'https://a.com/x', title: 'T', domain: '' }]) {
      if (toRow({ ...bad, impact: 1 }, 'IN', '2026-08-24', at) !== null) throw new Error(`should have refused: ${JSON.stringify(bad)}`);
    }
    return 'accepts complete rows, refuses 3 malformed shapes';
  });

  check('schema + idempotent upsert', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA);
    const statement = db.prepare(UPSERT);
    const row = toRow({ url: 'https://a.com/x', title: 'First', domain: 'a.com', seendate: '20260824T090000Z', impact: 2, distinctDomains: 2 }, 'IN', '2026-08-24', '2026-08-24T00:00:00.000Z');
    statement.run(...row);
    const again = toRow({ url: 'https://www.a.com/x/?utm_source=n', title: 'First, updated', domain: 'a.com', seendate: '20260824T090000Z', impact: 5, distinctDomains: 14 }, 'IN', '2026-08-24', '2026-08-24T01:00:00.000Z');
    statement.run(...again);
    const count = db.prepare('SELECT COUNT(*) c FROM news').get().c;
    const stored = db.prepare('SELECT impact, title FROM news').get();
    db.close();
    if (count !== 1) throw new Error(`url variant created a second row (${count}) — the pin would move`);
    if (stored.impact !== 5 || stored.title !== 'First, updated') throw new Error('re-ingest did not update the row');
    return '1 row after 2 writes, regraded 2 -> 5';
  });

  await (async () => {
    try {
      const fixture = path.join(REPO_ROOT, 'src', 'data', 'fixtures', 'gdelt-doc-artlist-synthetic.json');
      const db = new DatabaseSync(':memory:');
      db.exec(SCHEMA);
      const result = await ingestDay(db, 'IN', '2026-08-24', { fixture, sliceHours: 24 });
      db.close();
      const shape = `${result.written} rows, ${result.publishers} publishers, ${formatTally(result.tally)}`;
      if (result.written !== 29 || result.tally[5] !== 15) throw new Error(`fixture graded unexpectedly: ${shape}`);
      results.push({ name: 'end-to-end ingest (fixture)', ok: true, detail: shape });
    } catch (error) {
      results.push({ name: 'end-to-end ingest (fixture)', ok: false, detail: error.message });
    }
  })();

  const failed = results.filter((entry) => !entry.ok);
  for (const entry of results) log(`[self-test] ${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name.padEnd(42)} ${entry.detail}`);
  log(`[self-test] ${results.length - failed.length}/${results.length} passed`);
  return failed.length === 0;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.h) {
    log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*\n?|^ \* ?|^ \*$/gm, ''));
    return;
  }
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (major < 24) {
    log(`[news-ingest] warning: Node ${process.versions.node}; this repo targets Node 24+ (node:sqlite is experimental before 24).`);
  }

  if (options.diagnose) {
    await diagnose();
    return;
  }

  if (options['self-test']) {
    if (!await selfTest()) process.exitCode = 1;
    return;
  }

  const country = normalizeCountryCode(options.country || 'IN');
  if (!country) {
    log(`[news-ingest] --country must be an ISO 3166-1 alpha-2 code, got: ${options.country}`);
    process.exitCode = 2;
    return;
  }
  const gdeltCountry = normalizeCountryCode(options['gdelt-country']) || country;
  const lang = String(options.lang || 'english').toLowerCase().replace(/[^a-z]/g, '') || 'english';
  const maxRecords = Math.min(
    GDELT_MAX_RECORDS,
    Math.max(1, Number.parseInt(String(options.max ?? GDELT_MAX_RECORDS), 10) || GDELT_MAX_RECORDS),
  );

  const today = dayKeyFromMs(Date.now());
  let days;
  if (options.day) {
    const single = normalizeDayKey(options.day);
    days = single ? [single] : [];
  } else if (options.from || options.to) {
    days = dayKeyRange(options.from || today, options.to || today);
  } else {
    const span = Math.max(1, Number.parseInt(String(options.days ?? 2), 10) || 2);
    days = dayKeyRange(dayKeyFromMs(Date.now() - (span - 1) * 86_400_000), today);
  }
  if (!days.length) {
    log('[news-ingest] no valid days to ingest — check --day / --from / --to (YYYY-MM-DD, UTC).');
    process.exitCode = 2;
    return;
  }

  const timeoutSeconds = Number.parseInt(String(options.timeout ?? ''), 10);
  if (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) requestTimeoutMs = timeoutSeconds * 1000;

  const allowHttp = Boolean(options['allow-http']);
  const sliceHours = options['slice-hours'] === undefined
    ? 2
    : Math.min(24, Math.max(1, Number.parseInt(String(options['slice-hours']), 10) || 1));
  const saveResponse = typeof options['save-response'] === 'string' && options['save-response']
    ? path.resolve(options['save-response'])
    : (options['save-response'] === true ? path.join(REPO_ROOT, '.gev-cache', 'gdelt-raw') : null);
  const sort = /^(datedesc|dateasc|tonedesc|toneasc|hybridrel)$/i.test(String(options.sort || ''))
    ? String(options.sort).toLowerCase()
    : 'datedesc';
  if (allowHttp) log('[news-ingest] --allow-http: fetching over plain HTTP (public data, no credentials sent).');

  const dbPath = await resolveDbPath(options);
  const db = options['dry-run'] ? null : openDatabase(dbPath);

  log(`[news-ingest] ${country}${gdeltCountry === country ? '' : ` (GDELT: ${gdeltCountry})`} · ${lang} · ${days.length} day(s) ${days[0]} → ${days.at(-1)}`);
  log(`[news-ingest] ${options['dry-run'] ? 'DRY RUN — nothing will be written' : `→ ${dbPath}`}`);
  if (saveResponse) log(`[news-ingest] saving raw upstream responses to ${saveResponse}`);
  if (!options.fixture) log(`[news-ingest] ${24 / sliceHours} request(s) per day, ${sliceHours}h windows, sort=${sort}, max ${maxRecords}/window`);
  if (options.fixture) log(`[news-ingest] fixture mode: ${options.fixture} (no network)`);

  const totals = { fetched: 0, written: 0, skipped: 0, failed: 0 };
  let hintShown = false;
  try {
    for (const [index, day] of days.entries()) {
      try {
        const result = await ingestDay(db, country, day, { ...options, gdeltCountry, lang, maxRecords, allowHttp, sliceHours, sort, saveResponse });
        totals.fetched += result.fetched;
        totals.written += result.written;
        totals.skipped += result.skipped;
        const windowNote = result.failedWindows ? ` (${result.failedWindows}/${result.windows} windows failed)` : '';
        log(`  ${day}  fetched ${String(result.fetched).padStart(4)}  written ${String(result.written).padStart(4)}  publishers ${String(result.publishers).padStart(3)}  ${formatTally(result.tally)}${windowNote}`);
        if (result.publishers > 0 && result.publishers < 12) {
          log(`            ^ only ${result.publishers} publishers — too few for syndication to show. Try --slice-hours=1.`);
        }
      } catch (error) {
        totals.failed++;
        // One bad day must not abandon a 90-day backfill. The window overlaps
        // and the upsert is idempotent, so the next run picks this day back up.
        log(`  ${day}  FAILED — ${describeFetchError(error)}`);
        const hint = fetchHint(error);
        if (hint && !hintShown) { log(`            ${hint}`); hintShown = true; }
      }
      if (!options.fixture && index < days.length - 1) await sleep(REQUEST_SPACING_MS);
    }
  } finally {
    db?.close();
  }

  log(`[news-ingest] done — ${totals.written} rows written, ${totals.skipped} unusable, ${totals.failed} day(s) failed.`);
  if (totals.failed === days.length) {
    log('[news-ingest] every day failed. Run `node scripts/news-ingest.mjs --diagnose` to find out where the network path stops.');
    process.exitCode = 1;
  }
}

await main();
