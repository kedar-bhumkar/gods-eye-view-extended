import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import { governorRequestRender } from '../renderGovernor.js';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
} from './contextStore.js';
import { placeEvent } from './wikiPulsePlacement.js';
import {
  WIKI_PULSE_OVERLAY_SOURCE_ID as OVERLAY_SOURCE_ID,
  classifyEdit,
  createWikiPulseCardEntry,
  describeWikiPulseState,
  redactUser,
} from './wikiPulsePresentation.js';

// Re-exported so `src/data/wikiPulse.js` stays the layer's single public entry point.
export {
  classifyEdit, createWikiPulseCardEntry, describeWikiPulseState, redactUser,
} from './wikiPulsePresentation.js';

/**
 * @module data/wikiPulse
 * @description An ambient "pulse of the internet" — live Wikipedia edits,
 * worldwide, as they happen, sourced from Wikimedia's public EventStreams
 * `recentchange` feed via the `/api/wikipulse` server proxy.
 *
 * Deliberately not analytical: pin positions are decorative (see
 * `wikiPulsePlacement.js`), and the layer answers "is the world editing right
 * now" rather than "where is this edit from". Two consequences:
 *
 *  - **Always now, never scoped.** Unlike `news.js` there is no day or
 *    country parameter — the layer just polls and shows whatever is live.
 *  - **Append, don't replace.** A poll is a delta of new edits, not a
 *    snapshot to redraw from — blips accumulate and expire on their own TTL
 *    rather than being cleared and rebuilt every tick, so the effect reads as
 *    a pulse rather than a flicker.
 */

const API_URL = '/api/wikipulse';
const COUNTRIES_URL = new URL('./local_data/natural_earth/countries.json', import.meta.url).href;

/** How long a blip stays on the globe before it expires. */
const PIN_TTL_MS = 90_000;
/** Hard ceiling on tracked rows, so a burst cannot grow the source forever. */
const MAX_TRACKED_ROWS = 500;

/**
 * Build the layer. A factory rather than a singleton so tests can drive it
 * with injected transport and geometry.
 * @param {object} [deps] Injection seams.
 * @returns {object} A DataLayerManager-compatible layer module.
 */
export function createWikiPulseLayer({
  fetchImpl = null, loadCountries = null, pinTtlMs = PIN_TTL_MS, nowFn = Date.now,
} = {}) {
  const doFetch = (...args) => (fetchImpl || globalThis.fetch)(...args);

  let _dataSource = null;
  let _enabled = false;
  let _destroyed = false;
  let _countries = null;
  let _countriesPromise = null;
  let _clickHandler = null;
  let _selectedId = null;
  /** @type {Map<string, object>} Placed rows by id, insertion order = arrival order. */
  const _rowsById = new Map();

  let _count = 0;
  let _lastUpdate = null;
  let _error = null;
  let _status = 'idle';

  /** Lazily load the bundled country polygons — 2.9 MB, so never at boot. */
  async function countries() {
    if (_countries) return _countries;
    if (!_countriesPromise) {
      _countriesPromise = (loadCountries
        ? loadCountries()
        : doFetch(COUNTRIES_URL).then((r) => r.json()).then((d) => d.countries))
        .then((list) => { _countries = list; return list; })
        .catch((error) => {
          _countriesPromise = null;
          console.warn('[wiki-pulse] country polygons failed to load:', error);
          throw error;
        });
    }
    return _countriesPromise;
  }

  function removeRow(id) {
    const entity = _dataSource?.entities.getById(`wiki:${id}`);
    if (entity) _dataSource.entities.remove(entity);
    _rowsById.delete(id);
    if (_selectedId === id) showCard(null);
  }

  /** Drop expired blips, then trim to the hard cap oldest-first. */
  function prune(nowMs) {
    if (!_dataSource) return;
    for (const [id, row] of _rowsById) {
      if (nowMs - row.__addedAt > pinTtlMs) removeRow(id);
    }
    while (_rowsById.size > MAX_TRACKED_ROWS) {
      const oldestId = _rowsById.keys().next().value;
      if (oldestId === undefined) break;
      removeRow(oldestId);
    }
  }

  function addRow(row, countryList) {
    if (!_dataSource || _rowsById.has(row.id)) return;
    const placed = placeEvent(row, countryList);
    if (!placed) return;

    const { color, dotPx } = classifyEdit(row);
    const entity = _dataSource.entities.add({
      id: `wiki:${row.id}`,
      position: Cesium.Cartesian3.fromDegrees(placed.lon, placed.lat),
      point: {
        pixelSize: dotPx,
        color: Cesium.Color.fromCssColorString(color).withAlpha(0.85),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.5),
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    entity.__gevWikiId = row.id;

    const placedRow = {
      ...row, lat: placed.lat, lon: placed.lon, __addedAt: nowFn(),
    };
    _rowsById.set(row.id, placedRow);

    registerEntityContext(entity, {
      id: `wiki:${row.id}`,
      layerId: 'wiki-pulse',
      layerName: 'Wiki Pulse',
      source: row.wiki,
      label: row.title,
      properties: {
        title: row.title,
        wiki: row.wiki,
        editor: row.user,
        bot: row.bot,
        byteDelta: row.byteDelta,
        placement: "illustrative, not the edit's real location",
      },
      latitude: Number(placed.lat.toFixed(6)),
      longitude: Number(placed.lon.toFixed(6)),
    });
  }

  /** Publish the selected blip's card, or clear it when nothing is selected. */
  function showCard(entity) {
    if (!entity) {
      _selectedId = null;
      clearOverlaySource(OVERLAY_SOURCE_ID);
      clearSelectedEntityContextForLayer('wiki-pulse');
      governorRequestRender('wiki-pulse:deselect');
      return;
    }
    const row = _rowsById.get(entity.__gevWikiId);
    if (!row) return;
    _selectedId = row.id;
    const position = entity.position?.getValue(Cesium.JulianDate.now());
    if (!position) return;
    setOverlayEntries(OVERLAY_SOURCE_ID, [createWikiPulseCardEntry(row, position)]);
    setOverlaySourceVisible(OVERLAY_SOURCE_ID, true);
    selectEntityContext(entity);
    governorRequestRender('wiki-pulse:select');
  }

  async function fetchSnapshot() {
    const response = await doFetch(API_URL);
    if (!response.ok) throw new Error(`Wiki Pulse API ${response.status}`);
    return response.json();
  }

  const layer = {
    id: 'wiki-pulse',
    name: 'Wiki Pulse',
    icon: '📝',
    source: 'Wikimedia EventStreams',
    // Always-now polling, no camera/day scoping — see the module header.
    updateInterval: 3000,

    async init(viewer) {
      _dataSource = new Cesium.CustomDataSource('wiki-pulse');
      await viewer.dataSources.add(_dataSource);
      _dataSource.show = false;
    },

    async enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      if (!_clickHandler) {
        _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        _clickHandler.setInputAction((movement) => {
          if (!_enabled) return;
          const picked = viewer.scene.pick(movement.position);
          const entity = picked?.id;
          if (entity?.__gevWikiId) {
            viewer.selectedEntity = entity;
            showCard(entity);
          } else if (_selectedId) {
            showCard(null);
          }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      }
      governorRequestRender('wiki-pulse:enable');
      return true;
    },

    async disable() {
      _enabled = false;
      showCard(null);
      setOverlaySourceVisible(OVERLAY_SOURCE_ID, false);
      if (_dataSource) _dataSource.show = false;
      if (_clickHandler) { _clickHandler.destroy(); _clickHandler = null; }
      governorRequestRender('wiki-pulse:disable');
      return true;
    },

    async update() {
      if (_destroyed) return true;
      try {
        const countryList = await countries();
        const payload = await fetchSnapshot();
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        _status = payload?.status || 'idle';
        _error = payload?.error || null;

        for (const raw of rows) {
          if (!raw?.id || _rowsById.has(raw.id)) continue;
          addRow({
            id: raw.id,
            wiki: raw.wiki,
            title: raw.title,
            url: raw.url,
            // Redacted again here even though the proxy already redacts —
            // a raw IP must never reach an entity through either path alone.
            user: redactUser(raw.user),
            bot: Boolean(raw.bot),
            type: raw.type,
            comment: raw.comment,
            byteDelta: raw.byteDelta,
            timestampMs: raw.timestampMs,
          }, countryList);
        }

        prune(nowFn());
        _count = _rowsById.size;
        _lastUpdate = nowFn();
        governorRequestRender('wiki-pulse:update');
        return true;
      } catch (error) {
        _error = String(error?.message || error);
        console.warn('[wiki-pulse] update failed:', error);
        return false;
      }
    },

    getStats() {
      const rows = [..._rowsById.values()];
      const humanCount = rows.filter((row) => !row.bot).length;
      const humanPct = rows.length ? (humanCount / rows.length) * 100 : null;
      const ratePerMin = _count * (60_000 / pinTtlMs);
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _error,
        status: _status,
        meta: describeWikiPulseState({
          count: _count, ratePerMin, humanPct, status: _status,
        }),
      };
    },

    async destroy(viewer) {
      _destroyed = true;
      await layer.disable();
      clearOverlaySource(OVERLAY_SOURCE_ID);
      removeEntityContextsForLayer('wiki-pulse');
      _rowsById.clear();
      if (_dataSource && viewer) viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _countries = null;
      _countriesPromise = null;
      return true;
    },
  };

  return layer;
}

const wikiPulseLayer = createWikiPulseLayer();
export default wikiPulseLayer;
