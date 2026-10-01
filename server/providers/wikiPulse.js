/**
 * Wiki Pulse provider — keyless SSE relay of Wikimedia's public recentchange
 * feed. Fork addition; moved here from the pre-split vite.config.js unchanged.
 */
import { redactUser as redactWikiPulseUser } from '../../src/data/wikiPulsePresentation.js';

const WIKI_PULSE_STREAM_URL = 'https://stream.wikimedia.org/v2/stream/recentchange';
/** Reconnect delays after a dropped stream, capped at the last entry. */
const WIKI_PULSE_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
/** Oldest-evicted ring buffer of relayed events. */
const WIKI_PULSE_BUFFER_MAX = 300;
/** Idempotent background reconnect check — recovery must not depend on browser traffic. */
const WIKI_PULSE_TICK_MS = 5000;

/**
 * Keyless server-side relay for Wikimedia's public `recentchange` SSE feed.
 *
 * Node has no built-in EventSource, so this reads the stream's raw bytes off
 * `fetch`'s `ReadableStream` body and parses `\n\n`-delimited SSE frames by
 * hand — no new dependency for what is, structurally, "split on blank lines
 * and JSON.parse the data: lines".
 *
 * Deliberately simpler than the AIS adapter (`aisStreamAdapter.js`): no API
 * key, no auth-failure states, no per-subscription watchdog policy — just
 * idle/connecting/live/degraded and a capped backoff, because a public feed
 * with no quota and no credential to expire does not need that machinery.
 *
 * The server keeps no geometry — see `wikiPulsePlacement.js` for why a
 * recentchange event cannot honestly be placed on a map at all, let alone
 * server-side. This relay's only editorial decisions are (1) which events are
 * even Wikipedia article edits, and (2) redacting anonymous editors' IP
 * addresses before they ever leave the server.
 * @param {object} [options]
 * @param {string} [options.streamUrl] Override for tests.
 * @param {typeof fetch} [options.fetchImpl] Override for tests.
 * @param {() => number} [options.now] Override for tests.
 * @returns {{handleWikiPulse: Function, ensureConnection: Function, connectOnce: Function, startTick: Function, dispose: Function, getStatus: Function}}
 */
export function createWikiPulseProxyMiddleware({
  streamUrl = WIKI_PULSE_STREAM_URL,
  fetchImpl = null,
  now = Date.now,
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch;

  let _status = 'idle';
  let _error = null;
  let _lastEventAt = null;
  let _reconnectAttempt = 0;
  let _connecting = false;
  let _activePromise = null;
  let _reconnectTimer = null;
  let _tickTimer = null;
  let _generation = 0;
  let _controller = null;
  /** @type {Array<object>} Oldest first, capped at {@link WIKI_PULSE_BUFFER_MAX}. */
  let _buffer = [];

  function pushRow(row) {
    _buffer.push(row);
    if (_buffer.length > WIKI_PULSE_BUFFER_MAX) _buffer.shift();
  }

  /**
   * Keep only Wikipedia article edits, redact the editor before it ever
   * leaves the server, and use Wikimedia's own event id rather than
   * inventing one.
   * @param {object} event Parsed `data:` payload.
   * @returns {object|null} Relayed row, or null when filtered out.
   */
  function normalizeEvent(event) {
    if (!event || typeof event !== 'object') return null;
    if (event.type !== 'edit' && event.type !== 'new') return null;
    const serverName = String(event.server_name || '');
    if (!/\.wikipedia\.org$/.test(serverName)) return null;
    const id = event.meta?.id;
    if (!id) return null;

    const lengthNew = Number(event.length?.new);
    const lengthOld = Number(event.length?.old);
    const byteDelta = Number.isFinite(lengthNew) && Number.isFinite(lengthOld)
      ? lengthNew - lengthOld
      : null;
    const title = String(event.title || '').trim() || null;
    const url = event.meta?.uri
      || (title ? `https://${serverName}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}` : null);
    const timestampSec = Number(event.timestamp);

    return {
      id: String(id),
      wiki: serverName,
      title,
      url,
      // Redacted here, at the only point the raw value ever exists server-side.
      user: redactWikiPulseUser(event.user),
      bot: Boolean(event.bot),
      type: event.type,
      comment: typeof event.comment === 'string' ? event.comment.slice(0, 280) : null,
      byteDelta,
      timestampMs: Number.isFinite(timestampSec) ? timestampSec * 1000 : now(),
    };
  }

  /** Parse complete `\n\n`-terminated SSE frames out of a growing buffer. */
  function consumeFrames(buffered, generation) {
    let text = buffered;
    let index = text.indexOf('\n\n');
    while (index !== -1) {
      if (generation !== _generation) return text;
      const frame = text.slice(0, index);
      text = text.slice(index + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const jsonText = line.slice(5).trim();
        if (!jsonText) continue;
        let event;
        try { event = JSON.parse(jsonText); } catch { continue; }
        const row = normalizeEvent(event);
        if (row) { pushRow(row); _lastEventAt = now(); }
      }
      index = text.indexOf('\n\n');
    }
    return text;
  }

  function scheduleReconnect(generation) {
    const delay = WIKI_PULSE_BACKOFF_MS[Math.min(_reconnectAttempt, WIKI_PULSE_BACKOFF_MS.length - 1)];
    _reconnectAttempt += 1;
    _status = 'degraded';
    clearTimeout(_reconnectTimer);
    _reconnectTimer = setTimeout(() => {
      if (generation !== _generation) return;
      void connect(generation);
    }, delay);
    _reconnectTimer.unref?.();
  }

  async function connect(generation) {
    if (_connecting) return;
    _connecting = true;
    _status = 'connecting';
    _controller = new AbortController();
    try {
      const response = await doFetch(streamUrl, {
        headers: { Accept: 'text/event-stream' },
        signal: _controller.signal,
      });
      if (generation !== _generation) return;
      if (!response?.ok || !response.body) {
        throw new Error(`Wikimedia stream HTTP ${response?.status ?? 'error'}`);
      }
      _status = 'live';
      _error = null;
      _reconnectAttempt = 0;
      _connecting = false;

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffered = '';
      for (;;) {
        if (generation !== _generation) {
          try { await reader.cancel(); } catch { /* already gone */ }
          return;
        }
        // eslint-disable-next-line no-await-in-loop
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        buffered = consumeFrames(buffered, generation);
      }
      if (generation !== _generation) return;
      throw new Error('Wikimedia stream ended');
    } catch (error) {
      if (generation !== _generation) return;
      _error = String(error?.message || error);
      _connecting = false;
      scheduleReconnect(generation);
    }
  }

  /** Idempotent lazy connect — safe to call on every request and on a tick. */
  function ensureConnection() {
    if (_status === 'live' || _status === 'connecting' || _reconnectTimer) return _activePromise;
    _activePromise = connect(_generation).finally(() => { _activePromise = null; });
    return _activePromise;
  }

  function statusSnapshot() {
    return {
      status: _status,
      error: _error,
      lastEventAt: _lastEventAt,
      silentForMs: _lastEventAt ? now() - _lastEventAt : null,
      reconnectAttempt: _reconnectAttempt,
    };
  }

  function handleWikiPulse(req, res) {
    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }
    ensureConnection();
    const params = new URL(req.url || '', 'http://localhost').searchParams;
    const requestedLimit = Number.parseInt(String(params.get('limit') ?? ''), 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(WIKI_PULSE_BUFFER_MAX, Math.max(1, requestedLimit))
      : WIKI_PULSE_BUFFER_MAX;
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({
      rows: _buffer.slice(-limit),
      source: 'Wikimedia EventStreams',
      ...statusSnapshot(),
    }));
  }

  function startTick() {
    if (_tickTimer) return;
    _tickTimer = setInterval(() => {
      try { ensureConnection(); } catch { /* ignore */ }
    }, WIKI_PULSE_TICK_MS);
    _tickTimer.unref?.();
  }

  /** Invalidate the current generation so any in-flight read loop stops, then reset. */
  function dispose() {
    _generation += 1;
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
    clearInterval(_tickTimer);
    _tickTimer = null;
    if (_controller) { try { _controller.abort(); } catch { /* already aborted */ } }
    _controller = null;
    _buffer = [];
    _status = 'idle';
    _error = null;
    _reconnectAttempt = 0;
    _lastEventAt = null;
    _connecting = false;
    _activePromise = null;
  }

  return {
    handleWikiPulse,
    ensureConnection,
    connectOnce: () => connect(_generation),
    startTick,
    dispose,
    getStatus: statusSnapshot,
  };
}

/**
 * Vite plugin wrapper around {@link createWikiPulseProxyMiddleware}.
 * @returns {import('vite').Plugin} The plugin.
 */
export function wikiPulseProxy() {
  const api = createWikiPulseProxyMiddleware({});
  const install = (middlewares) => { middlewares.use('/api/wikipulse', api.handleWikiPulse); };
  return {
    name: 'wiki-pulse-proxy',
    configureServer(server) {
      install(server.middlewares);
      api.startTick();
      server.httpServer?.on('close', api.dispose);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
      api.startTick();
      server.httpServer?.on('close', api.dispose);
    },
    // Middleware-mode backstop: there is no httpServer to hang 'close' on.
    closeBundle() { api.dispose(); },
  };
}
