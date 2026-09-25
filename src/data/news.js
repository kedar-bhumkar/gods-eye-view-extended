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
import {
  addDays,
  dayKeyFromMs,
  impactBand,
  newsImpactLegend,
  normalizeCountryCode,
  normalizeDayKey,
} from './newsPolicy.js';
import {
  MAX_PINS,
  NEWS_OVERLAY_SOURCE_ID as OVERLAY_SOURCE_ID,
  chooseImpactFloor,
  createNewsCardEntry,
  describeNewsState,
} from './newsPresentation.js';

// Re-exported so `src/data/news.js` stays the layer's single public entry point.
export {
  MAX_PINS, chooseImpactFloor, createNewsCardEntry, describeNewsState,
} from './newsPresentation.js';
import { countryAt, placeArticles } from './newsPlacement.js';

/**
 * @module data/news
 * @description Country news for one day, pinned on the globe.
 *
 * The repo's first honestly non-real-time layer. Three consequences shape it:
 *
 *  - **The Cesium clock is never touched.** `flights.js` renders a poll behind
 *    wall-clock and interpolates against `viewer.clock`; `satellites.js`
 *    propagates SGP4 from it. Rewinding it to show last Tuesday's news would
 *    send every aircraft on the globe backwards. The date is a layer parameter.
 *  - **Nothing polls.** `updateInterval: 0` with a slow `refreshInterval`, so
 *    today's newly-ingested rows appear without a reload and nothing else runs.
 *  - **No continuous render hold.** Pins do not animate, so the idle governor
 *    stays idle; a re-query asks for exactly one frame.
 */

const API_URL = '/api/news';
const CALENDAR_URL = '/api/news/calendar';
const COUNTRIES_URL = new URL('./local_data/natural_earth/countries.json', import.meta.url).href;

/** Refresh cadence for the current day. News is not live; fifteen minutes is plenty. */
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
/** Camera moves smaller than this do not re-resolve the country. */
const COUNTRY_RECHECK_MOVE_DEG = 0.35;

/**
 * Build the layer. A factory rather than a singleton so tests can drive it with
 * injected transport and geometry.
 * @param {object} [deps] Injection seams.
 * @returns {object} A DataLayerManager-compatible layer module.
 */
export function createNewsLayer({ fetchImpl = null, loadCountries = null } = {}) {
  const doFetch = (...args) => (fetchImpl || globalThis.fetch)(...args);

  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _destroyed = false;
  let _countries = null;
  let _countriesPromise = null;
  let _clickHandler = null;
  let _cameraMoveEnd = null;
  let _rowControlsListener = null;
  let _selectedId = null;
  /** @type {Map<string, object>} Placed rows by id, for the selection card. */
  const _rowsById = new Map();

  /** @type {{country: string|null, day: string|null}} */
  let _params = { country: null, day: null };
  let _resolvedCountry = null;
  let _lastCameraKey = '';
  let _day = dayKeyFromMs(Date.now());
  let _calendar = [];
  let _tally = {};
  let _count = 0;
  let _hidden = 0;
  let _floor = 1;
  let _lastUpdate = null;
  let _error = null;
  let _unavailable = false;
  let _loading = false;

  const notifyRowControls = () => { try { _rowControlsListener?.(); } catch { /* ignore */ } };

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
          console.warn('[news] country polygons failed to load:', error);
          throw error;
        });
    }
    return _countriesPromise;
  }

  /** Which country is the camera over? Cheap-rejected on small camera moves. */
  async function resolveCountry(viewer) {
    if (_params.country) return _params.country;
    const carto = viewer?.camera?.positionCartographic;
    if (!carto) return _resolvedCountry;
    const lat = Cesium.Math.toDegrees(carto.latitude);
    const lon = Cesium.Math.toDegrees(carto.longitude);
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    if (key === _lastCameraKey && _resolvedCountry) return _resolvedCountry;
    _lastCameraKey = key;
    const list = await countries();
    const match = countryAt(list, lat, lon);
    _resolvedCountry = match?.iso || null;
    return _resolvedCountry;
  }

  async function fetchDay(country, day) {
    const url = `${API_URL}?country=${encodeURIComponent(country)}&day=${encodeURIComponent(day)}&limit=${MAX_PINS}`;
    const response = await doFetch(url);
    if (response.status === 503) {
      _unavailable = true;
      throw new Error('News database unavailable');
    }
    if (!response.ok) throw new Error(`News API ${response.status}`);
    _unavailable = false;
    return response.json();
  }

  async function fetchCalendar(country) {
    try {
      const response = await doFetch(`${CALENDAR_URL}?country=${encodeURIComponent(country)}`);
      if (!response.ok) return [];
      const payload = await response.json();
      return Array.isArray(payload?.days) ? payload.days : [];
    } catch {
      return [];
    }
  }

  /** Replace the drawn entities with this day's pins. */
  function render(rows, country) {
    if (!_dataSource) return;
    _dataSource.entities.removeAll();
    _rowsById.clear();
    removeEntityContextsForLayer('news');
    if (!rows.length) return;

    const countryRecord = _countries?.find((entry) => entry.iso === country);
    if (!countryRecord) return;

    const { placed } = placeArticles(rows, countryRecord);
    for (const row of placed) {
      const band = impactBand(row.impact);
      const entity = _dataSource.entities.add({
        id: `news:${row.id}`,
        position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat),
        point: {
          pixelSize: band.dotPx,
          color: Cesium.Color.fromCssColorString(band.color).withAlpha(0.92),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.55),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      entity.__gevNewsId = row.id;
      _rowsById.set(row.id, row);
      // Registering makes the pin answerable to voice ("what am I looking at")
      // and to anything else reading the shared selection slot.
      registerEntityContext(entity, {
        id: `news:${row.id}`,
        layerId: 'news',
        layerName: 'News',
        source: row.source,
        label: row.title,
        properties: {
          headline: row.title,
          publisher: row.source,
          impact: `${row.impact} (${band.label})`,
          outlets: row.distinctDomains,
          published: row.publishedAt,
          url: row.url,
          placement: 'scattered within country, not the event location',
        },
        latitude: Number(row.lat.toFixed(6)),
        longitude: Number(row.lon.toFixed(6)),
      });
      entity.properties = new Cesium.PropertyBag({
        newsId: row.id,
        title: row.title,
        source: row.source,
        url: row.url,
        impact: row.impact,
        impactLabel: band.label,
        outlets: row.distinctDomains,
        publishedAt: row.publishedAt,
        day: _day,
        // The pin is scattered, not located. Say so wherever it is shown.
        placement: row.source === 'record' ? 'reported location' : 'scattered within country',
      });
      entity.description = [
        `<h3>${escapeHtml(row.title)}</h3>`,
        `<p><b>${band.label}</b> — carried by ${row.distinctDomains} outlet${row.distinctDomains === 1 ? '' : 's'}</p>`,
        `<p>${escapeHtml(row.source)} · ${escapeHtml(String(row.publishedAt).slice(0, 16).replace('T', ' '))} UTC</p>`,
        row.url ? `<p><a href="${escapeHtml(row.url)}" target="_blank" rel="noopener">Read the article</a></p>` : '',
        '<p><small>Pin position is scattered within the country, not the location of the event.</small></p>',
      ].join('');
    }
  }

  /** Publish the selected pin's card, or clear it when nothing is selected. */
  function showCard(entity) {
    if (!entity) {
      _selectedId = null;
      clearOverlaySource(OVERLAY_SOURCE_ID);
      clearSelectedEntityContextForLayer('news');
      governorRequestRender('news:deselect');
      return;
    }
    const row = _rowsById.get(entity.__gevNewsId);
    if (!row) return;
    _selectedId = row.id;
    const position = entity.position?.getValue(Cesium.JulianDate.now());
    if (!position) return;
    setOverlayEntries(OVERLAY_SOURCE_ID, [createNewsCardEntry(row, position)]);
    setOverlaySourceVisible(OVERLAY_SOURCE_ID, true);
    selectEntityContext(entity);
    governorRequestRender('news:select');
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[character]));
  }

  const layer = {
    id: 'news',
    name: 'News',
    icon: '📰',
    source: 'GDELT · local',
    // Camera-driven, not clock-driven: no poll loop, just a slow refresh so
    // today's newly-ingested rows turn up without a reload.
    updateInterval: 0,
    refreshInterval: REFRESH_INTERVAL_MS,
    statsRefreshInterval: 2000,

    async init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('news');
      await viewer.dataSources.add(_dataSource);
      _dataSource.show = false;
    },

    async enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      if (!_cameraMoveEnd) {
        _cameraMoveEnd = viewer.camera.moveEnd.addEventListener(() => {
          if (!_enabled || _params.country) return;
          void layer.update(viewer);
        });
      }
      if (!_clickHandler) {
        _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        _clickHandler.setInputAction((movement) => {
          if (!_enabled) return;
          const picked = viewer.scene.pick(movement.position);
          const entity = picked?.id;
          if (entity?.__gevNewsId) {
            viewer.selectedEntity = entity;
            showCard(entity);
          } else if (_selectedId) {
            // Clicking away dismisses our card, but only ours — another
            // layer's click is its own business.
            showCard(null);
          }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      }
      governorRequestRender('news:enable');
      return true;
    },

    async disable() {
      _enabled = false;
      showCard(null);
      setOverlaySourceVisible(OVERLAY_SOURCE_ID, false);
      if (_dataSource) _dataSource.show = false;
      if (_cameraMoveEnd) { _cameraMoveEnd(); _cameraMoveEnd = null; }
      if (_clickHandler) { _clickHandler.destroy(); _clickHandler = null; }
      governorRequestRender('news:disable');
      return true;
    },

    async update(viewer) {
      if (!_enabled || _destroyed) return true;
      _loading = true;
      try {
        const country = await resolveCountry(viewer || _viewer);
        if (!country) {
          _dataSource?.entities.removeAll();
          _count = 0; _hidden = 0; _tally = {}; _error = null;
          return true;
        }
        const day = normalizeDayKey(_params.day) || _day;
        _day = day;

        const payload = await fetchDay(country, day);
        const rows = Array.isArray(payload?.items) ? payload.items : [];
        const { floor, shown, hidden } = chooseImpactFloor(rows);
        _floor = floor;
        const visible = rows.filter((row) => row.impact >= floor);

        await countries();
        showCard(null);
        render(visible, country);

        _tally = {};
        for (const row of visible) _tally[row.impact] = (_tally[row.impact] || 0) + 1;
        _count = shown;
        _hidden = hidden + Math.max(0, (payload?.total || rows.length) - rows.length);
        _lastUpdate = Date.now();
        _error = null;
        if (!_calendar.length) _calendar = await fetchCalendar(country);
        governorRequestRender('news:update');
        notifyRowControls();
        return true;
      } catch (error) {
        _error = String(error?.message || error);
        console.warn('[news] update failed:', error);
        return false;
      } finally {
        _loading = false;
      }
    },

    /**
     * Runtime parameters: which country, and which day.
     * @param {{country?: string|null, day?: string|null}} params Requested state.
     * @returns {boolean} False rejects the transition.
     */
    setParams(params = {}) {
      if (Object.hasOwn(params, 'country')) {
        const value = params.country === null ? null : normalizeCountryCode(params.country);
        if (params.country !== null && !value) return false;
        _params = { ..._params, country: value };
        _resolvedCountry = value;
        _lastCameraKey = '';
      }
      if (Object.hasOwn(params, 'day')) {
        const value = params.day === null ? null : normalizeDayKey(params.day);
        if (params.day !== null && !value) return false;
        _params = { ..._params, day: value };
        _day = value || dayKeyFromMs(Date.now());
      }
      if (_enabled) void layer.update(_viewer);
      return true;
    },

    getParams() {
      return { country: _params.country, day: _params.day };
    },

    /**
     * Date chips and the impact legend, rendered by the manager under the
     * layer's toggle row. This is the whole date control until the tuner
     * panel lands — no markup, no new screen region.
     */
    getRowControls() {
      const today = dayKeyFromMs(Date.now());
      const isToday = _day === today;
      const previous = addDays(_day, -1);
      const next = addDays(_day, 1);
      return {
        chips: [
          { id: 'prev', label: '◀', title: `Show ${previous}`, params: { day: previous } },
          { id: 'day', label: _day, active: true, title: `Showing ${_day} (UTC)`, params: { day: _day } },
          {
            id: 'next',
            label: '▶',
            disabled: isToday || !next || next > today,
            title: isToday ? 'Already at the latest day' : `Show ${next}`,
            params: { day: next },
          },
          { id: 'today', label: 'TODAY', disabled: isToday, title: 'Jump to the latest day', params: { day: null } },
        ],
        legend: newsImpactLegend(_tally),
      };
    },

    setRowControlsListener(listener) {
      _rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        loading: _loading,
        error: _error,
        // A missing database must read UNAVAILABLE, never a quiet zero — a
        // silent 0 says "no news today", which is a different claim.
        status: _unavailable ? 'unavailable' : (_error ? 'degraded' : 'nominal'),
        meta: describeNewsState({
          country: _resolvedCountry,
          day: _day,
          shown: _count,
          hidden: _hidden,
          unavailable: _unavailable,
        }),
      };
    },

    async destroy(viewer) {
      _destroyed = true;
      await layer.disable();
      clearOverlaySource(OVERLAY_SOURCE_ID);
      removeEntityContextsForLayer('news');
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

const newsLayer = createNewsLayer();
export default newsLayer;
