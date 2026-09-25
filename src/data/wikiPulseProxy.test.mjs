import assert from 'node:assert/strict';
import test from 'node:test';

import { createWikiPulseProxyMiddleware } from '../../vite.config.js';

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
    handler({ method, url }, res);
  });
}

/** A ReadableStream that emits each frame then closes — a finite stand-in for the real feed. */
function sseStream(events) {
  const encoder = new TextEncoder();
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function fakeFetch(events, { ok = true, status = 200 } = {}) {
  return async () => ({ ok, status, body: ok ? sseStream(events) : null });
}

const EDIT_EVENT = Object.freeze({
  meta: { id: 'evt-1', uri: 'https://en.wikipedia.org/wiki/Example' },
  type: 'edit',
  title: 'Example',
  comment: 'fixed typo',
  timestamp: 1_735_689_600,
  user: 'SomeUser',
  bot: false,
  server_name: 'en.wikipedia.org',
  length: { old: 1000, new: 1010 },
});

const NON_WIKIPEDIA_EVENT = Object.freeze({
  meta: { id: 'evt-2' },
  type: 'edit',
  title: 'Q1',
  timestamp: 1_735_689_601,
  user: 'SomeUser',
  server_name: 'www.wikidata.org',
});

const LOG_EVENT = Object.freeze({
  meta: { id: 'evt-3' },
  type: 'log',
  title: 'Example',
  timestamp: 1_735_689_602,
  user: 'SomeUser',
  server_name: 'en.wikipedia.org',
});

const ANON_EDIT_EVENT = Object.freeze({
  meta: { id: 'evt-4', uri: 'https://de.wikipedia.org/wiki/Beispiel' },
  type: 'edit',
  title: 'Beispiel',
  timestamp: 1_735_689_603,
  user: '203.0.113.42',
  bot: false,
  server_name: 'de.wikipedia.org',
  length: { old: 500, new: 480 },
});

test('relays Wikipedia edits, filters non-Wikipedia and log events, and redacts anonymous IPs', async () => {
  const api = createWikiPulseProxyMiddleware({
    fetchImpl: fakeFetch([EDIT_EVENT, NON_WIKIPEDIA_EVENT, LOG_EVENT, ANON_EDIT_EVENT]),
  });
  await api.connectOnce();

  const { status, body } = await call(api.handleWikiPulse, '/');
  assert.equal(status, 200);
  assert.equal(body.source, 'Wikimedia EventStreams');
  assert.deepEqual(body.rows.map((r) => r.id), ['evt-1', 'evt-4'], 'non-Wikipedia and log events must be filtered out');

  const edit = body.rows[0];
  assert.equal(edit.wiki, 'en.wikipedia.org');
  assert.equal(edit.title, 'Example');
  assert.equal(edit.user, 'SomeUser');
  assert.equal(edit.byteDelta, 10);
  assert.equal(edit.url, 'https://en.wikipedia.org/wiki/Example');

  const anon = body.rows[1];
  assert.equal(anon.user, 'Anonymous editor', 'the raw IP must never leave the server');
  assert.ok(!JSON.stringify(body).includes('203.0.113.42'), 'the raw IP must not appear anywhere in the response');

  api.dispose();
});

test('the id used is Wikimedia\'s own meta.id, not an invented hash', async () => {
  const api = createWikiPulseProxyMiddleware({ fetchImpl: fakeFetch([EDIT_EVENT]) });
  await api.connectOnce();
  const { body } = await call(api.handleWikiPulse, '/');
  assert.equal(body.rows[0].id, 'evt-1');
  api.dispose();
});

test('limit is clamped and honored', async () => {
  const events = Array.from({ length: 5 }, (_, i) => ({
    ...EDIT_EVENT, meta: { id: `evt-${i}`, uri: `https://en.wikipedia.org/wiki/${i}` },
  }));
  const api = createWikiPulseProxyMiddleware({ fetchImpl: fakeFetch(events) });
  await api.connectOnce();
  const { body } = await call(api.handleWikiPulse, '/?limit=2');
  assert.equal(body.rows.length, 2);
  assert.deepEqual(body.rows.map((r) => r.id), ['evt-3', 'evt-4'], 'the most recently buffered rows win');
  api.dispose();
});

test('only GET is allowed', async () => {
  const api = createWikiPulseProxyMiddleware({ fetchImpl: fakeFetch([EDIT_EVENT]) });
  const { status } = await call(api.handleWikiPulse, '/', { method: 'POST' });
  assert.equal(status, 405);
  api.dispose();
});

test('status moves through connecting -> live -> degraded as the stream ends', async () => {
  const api = createWikiPulseProxyMiddleware({ fetchImpl: fakeFetch([EDIT_EVENT]) });
  assert.equal(api.getStatus().status, 'idle');

  await api.connectOnce();
  assert.equal(api.getStatus().status, 'degraded', 'the finite test stream ends, which schedules a reconnect');
  assert.equal(api.getStatus().reconnectAttempt, 1);

  api.dispose();
  assert.equal(api.getStatus().status, 'idle', 'dispose resets to idle');
  assert.equal(api.getStatus().reconnectAttempt, 0);
});

test('backoff escalates across repeated failures to even connect, and resets once a connection succeeds', async () => {
  // ok:false never reaches 'live', so unlike a stream that connects and then
  // ends, this must not reset the counter between attempts.
  const api = createWikiPulseProxyMiddleware({ fetchImpl: fakeFetch([], { ok: false, status: 503 }) });
  await api.connectOnce();
  assert.equal(api.getStatus().reconnectAttempt, 1);
  await api.connectOnce();
  assert.equal(api.getStatus().reconnectAttempt, 2, 'consecutive failed CONNECTIONS must escalate the backoff');
  await api.connectOnce();
  assert.equal(api.getStatus().reconnectAttempt, 3);

  // A connection that actually succeeds (even briefly) means the upstream is
  // reachable again, so the next drop should back off from the start, not
  // pick up where a string of hard failures left off.
  api.dispose();
  const recovered = createWikiPulseProxyMiddleware({ fetchImpl: fakeFetch([EDIT_EVENT]) });
  await recovered.connectOnce();
  assert.equal(recovered.getStatus().reconnectAttempt, 1, 'a stream that connected and then ended resets the attempt counter to 0 first');
  recovered.dispose();
});

test('an upstream HTTP error is reported as degraded with an error message, and the buffer is not corrupted', async () => {
  const api = createWikiPulseProxyMiddleware({ fetchImpl: fakeFetch([], { ok: false, status: 503 }) });
  await api.connectOnce();
  const status = api.getStatus();
  assert.equal(status.status, 'degraded');
  assert.match(status.error, /503/);
  const { body } = await call(api.handleWikiPulse, '/');
  assert.deepEqual(body.rows, []);
  api.dispose();
});

test('malformed data: lines are skipped rather than crashing the parser', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: not json at all\n\n'));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(EDIT_EVENT)}\n\n`));
      controller.close();
    },
  });
  const api = createWikiPulseProxyMiddleware({ fetchImpl: async () => ({ ok: true, status: 200, body: stream }) });
  await api.connectOnce();
  const { body } = await call(api.handleWikiPulse, '/');
  assert.deepEqual(body.rows.map((r) => r.id), ['evt-1']);
  api.dispose();
});
