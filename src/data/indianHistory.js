import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  hitTestWorldOverlay,
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
import { isOwnedByOtherLayer, registerPickOwner, resolvePickId, unregisterPickOwner } from './pickRegistry.js';
import { isOverlayCloseHit } from '../overlays/worldOverlayDraw.js';
import {
  DEFAULT_KINGDOM,
  ERA_IDS,
  HISTORY_COLORS,
  HISTORY_ERAS,
  INDIAN_HISTORY_LAYER_ID as LAYER_ID,
  INDIAN_HISTORY_OVERLAY_SOURCE_ID as OVERLAY_SOURCE_ID,
  KINGDOM_CHIPS,
  KINGDOM_IDS,
  createHistoryCardEntry,
  describeIndianHistoryState,
  eraOfKingdom,
  cityLabelCandidates,
  eventLabelCandidates,
  formatYear,
  historyLegend,
  isWikipediaUrl,
  orderedEvents,
  planLabelLayout,
  siteKey,
  validateKingdomData,
} from './indianHistoryPresentation.js';

// Re-exported so `src/data/indianHistory.js` stays the layer's single public entry point.
export {
  DEFAULT_KINGDOM, KINGDOM_IDS, createHistoryCardEntry, describeIndianHistoryState, validateKingdomData,
} from './indianHistoryPresentation.js';

/**
 * @module data/indianHistory
 * @description Historical Indian kingdoms (Nanda, Maurya, Gupta) from a
 * bundled, hand-curated dataset (`local_data/indian_history/kingdoms.json`).
 * One kingdom is shown at a time, picked with the row chips: its approximate
 * extent, key cities, and numbered key events. Clicking any of them opens a
 * card; clicking the card opens the Wikipedia article.
 *
 *  - **Static.** No network beyond the one lazy JSON load, so
 *    `updateInterval: 0` and `update()` only (re)renders when the selected
 *    kingdom differs from what is drawn.
 *  - **Camera only on explicit choice.** A user chip click flies to the
 *    kingdom; share/local restoration never moves the camera, which the
 *    restore flow owns.
 */

const DATA_URL = new URL('./local_data/indian_history/kingdoms.json', import.meta.url).href;
/**
 * Camera altitude per degree of a kingdom's larger span when flying to it.
 * Generous on purpose: the HUD's circular keyhole crops the frame edges.
 */
const FLY_ALTITUDE_M_PER_DEG = 245_000;
const FLY_MIN_ALTITUDE_M = 2_500_000;
/** Minimum spacing between label relayouts while the camera moves. */
const LAYOUT_THROTTLE_MS = 100;
const CITY_FONT = '12px sans-serif';
const CAPITAL_FONT = '600 14px sans-serif';
const EVENT_FONT = '12px sans-serif';
const TITLE_FONT = '600 17px sans-serif';
/** Marker footprint kept clear of labels. */
const MARKER_BOX_PX = 12;

function openInNewTab(url) {
  globalThis.window?.open?.(url, '_blank', 'noopener,noreferrer');
}

/**
 * Build the layer. A factory rather than a singleton so tests can inject
 * the dataset, overlay host, link opener, and click-handler factory.
 * @param {object} [deps] Injection seams.
 * @returns {object} A DataLayerManager-compatible layer module.
 */
export function createIndianHistoryLayer({
  loadData = null,
  openUrl = openInNewTab,
  overlayHost = {
    setEntries: setOverlayEntries,
    setVisible: setOverlaySourceVisible,
    clearSource: clearOverlaySource,
    hitTest: hitTestWorldOverlay,
  },
  screenSpaceEventHandlerFactory = (viewer) => new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
} = {}) {
  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _destroyed = false;
  let _data = null;
  let _dataPromise = null;
  let _kingdomId = DEFAULT_KINGDOM;
  /** Which era's chips the row shows; follows the kingdom unless the user browses. */
  let _eraId = eraOfKingdom(DEFAULT_KINGDOM);
  let _renderedKingdomId = null;
  let _clickHandler = null;
  /** Link opened by the currently shown card, keyed by its overlay entry id. */
  let _card = null;
  /** Entity whose card is open, so a second click on it closes the card. */
  let _cardEntityId = null;
  let _rowControlsListener = null;
  let _error = null;
  let _count = 0;
  let _lastUpdate = null;
  /** Rendered labels in placement priority order, with cached anchors. */
  let _labels = [];
  let _markerAnchors = [];
  let _postRenderRemover = null;
  let _moveEndRemover = null;
  let _lastLayoutMs = -Infinity;
  const _textWidths = new Map();
  let _measureCtx;
  const _scratchXY = new Cesium.Cartesian2();

  async function data() {
    if (_data) return _data;
    if (!_dataPromise) {
      _dataPromise = (loadData ? loadData() : fetch(DATA_URL).then((r) => {
        if (!r.ok) throw new Error(`kingdoms.json ${r.status}`);
        return r.json();
      }))
        .then((parsed) => {
          const problems = validateKingdomData(parsed);
          if (problems.length) throw new Error(`invalid kingdoms.json: ${problems[0]}`);
          _data = parsed;
          return parsed;
        })
        .catch((error) => {
          _dataPromise = null;
          throw error;
        });
    }
    return _dataPromise;
  }

  function kingdomById(id) {
    return _data?.kingdoms.find((kingdom) => kingdom.id === id) || null;
  }

  function notifyRowControls() {
    try { _rowControlsListener?.(); } catch (error) { console.warn('[indian-history] row refresh failed:', error); }
  }

  function tag(entity, kind, kingdom, item) {
    entity.__gevHistory = { kind, kingdomId: kingdom.id, itemId: item.id };
    registerEntityContext(entity, {
      id: entity.id,
      layerId: LAYER_ID,
      layerName: 'Indian History',
      source: 'Wikipedia (linked)',
      label: item.name || item.title,
      properties: {
        kingdom: kingdom.name,
        ...(kind === 'event' ? { year: formatYear(item.year, item.circa), summary: item.summary } : {}),
        ...(kind === 'city' ? { role: item.role, note: item.note } : {}),
        ...(kind === 'kingdom' ? { period: kingdom.period.label, borders: 'approximate' } : {}),
        wikipedia: item.wiki,
      },
      latitude: kind === 'kingdom' ? kingdom.anchor.lat : item.lat,
      longitude: kind === 'kingdom' ? kingdom.anchor.lon : item.lon,
    });
  }

  function clearRendered() {
    showCard(null);
    removeEntityContextsForLayer(LAYER_ID);
    _dataSource?.entities.removeAll();
    _labels = [];
    _markerAnchors = [];
    _renderedKingdomId = null;
    _count = 0;
  }

  function render(kingdom) {
    if (!_dataSource) return;
    clearRendered();
    const color = Cesium.Color.fromCssColorString(kingdom.color);
    const entities = _dataSource.entities;

    kingdom.extents.forEach((extent, extentIndex) => {
      // `holes` (validated to pair with a single ring) cut areas out of it.
      const holes = (extent.holes || []).map((ring) => Cesium.Cartesian3.fromDegreesArray(ring.flat()));
      extent.rings.forEach((ring, ringIndex) => {
        const positions = Cesium.Cartesian3.fromDegreesArray(ring.flat());
        const area = entities.add({
          id: `history:${kingdom.id}:extent:${extentIndex}:${ringIndex}`,
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(
              positions,
              holes.map((hole) => new Cesium.PolygonHierarchy(hole)),
            ),
            material: color.withAlpha(0.22),
            classificationType: Cesium.ClassificationType.BOTH,
          },
          polyline: {
            positions,
            width: 2,
            material: color.withAlpha(0.9),
            clampToGround: true,
          },
        });
        tag(area, 'kingdom', kingdom, kingdom);
      });
      holes.forEach((positions, holeIndex) => {
        entities.add({
          id: `history:${kingdom.id}:extent:${extentIndex}:hole:${holeIndex}`,
          polyline: {
            positions, width: 1.5, material: color.withAlpha(0.7), clampToGround: true,
          },
        });
      });
    });

    const title = entities.add({
      id: `history:${kingdom.id}:title`,
      position: Cesium.Cartesian3.fromDegrees(kingdom.anchor.lon, kingdom.anchor.lat),
      label: {
        text: `${kingdom.name.toUpperCase()}\n${kingdom.period.label}`,
        font: TITLE_FONT,
        fillColor: color,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    tag(title, 'kingdom', kingdom, kingdom);
    const titleRecord = labelRecord(title, TITLE_FONT, kingdom.name.toUpperCase(), 44, 'title');
    const cityRecords = [];
    const eventRecords = [];

    const markedSites = new Set();
    for (const city of kingdom.cities) {
      markedSites.add(siteKey(city));
      const capital = city.role === 'capital';
      const position = Cesium.Cartesian3.fromDegrees(city.lon, city.lat);
      _markerAnchors.push(position);
      const entity = entities.add({
        id: `history:${kingdom.id}:city:${city.id}`,
        position,
        point: {
          pixelSize: capital ? 12 : city.role === 'provincial' ? 9 : 7,
          color: Cesium.Color.fromCssColorString(capital ? HISTORY_COLORS.capital : HISTORY_COLORS.city),
          outlineColor: color,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: city.name,
          font: capital ? CAPITAL_FONT : CITY_FONT,
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          pixelOffset: new Cesium.Cartesian2(0, -16),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          // Minor cities fade out at whole-subcontinent zoom; capitals stay.
          translucencyByDistance: capital ? undefined : new Cesium.NearFarScalar(8e6, 1, 1.6e7, 0),
        },
      });
      tag(entity, 'city', kingdom, city);
      const record = labelRecord(entity, capital ? CAPITAL_FONT : CITY_FONT, city.name, capital ? 18 : 16, 'city');
      // Capitals always keep a label; a minor city's hides when there is no room.
      record.optional = !capital;
      cityRecords.push(record);
    }

    const events = orderedEvents(kingdom);
    const eventColor = Cesium.Color.fromCssColorString(HISTORY_COLORS.event);
    for (const event of events) {
      // A bare event site gets its own marker; at a city the city's marker serves.
      const needsMarker = !markedSites.has(siteKey(event));
      markedSites.add(siteKey(event));
      const position = Cesium.Cartesian3.fromDegrees(event.lon, event.lat);
      if (needsMarker) _markerAnchors.push(position);
      const entity = entities.add({
        id: `history:${kingdom.id}:event:${event.id}`,
        position,
        point: needsMarker ? {
          pixelSize: 8,
          color: eventColor,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        } : undefined,
        label: {
          text: `${event.number}. ${event.title}`,
          font: EVENT_FONT,
          fillColor: eventColor,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('rgba(18, 12, 8, 0.78)'),
          backgroundPadding: new Cesium.Cartesian2(6, 3),
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          pixelOffset: new Cesium.Cartesian2(0, 16),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          translucencyByDistance: new Cesium.NearFarScalar(9e6, 1, 1.8e7, 0),
        },
      });
      tag(entity, 'event', kingdom, event);
      // Background padding (6, 3) widens the painted box beyond the text.
      eventRecords.push(labelRecord(entity, EVENT_FONT, `${event.number}. ${event.title}`, 19, 'event', 12));
    }

    // Placement priority: title, capitals, other cities, then events in date order.
    _labels = [
      titleRecord,
      ...cityRecords.filter((r) => !r.optional),
      ...cityRecords.filter((r) => r.optional),
      ...eventRecords,
    ];
    _lastLayoutMs = -Infinity;
    layoutLabels();

    _renderedKingdomId = kingdom.id;
    _count = kingdom.cities.length + kingdom.events.length;
    _lastUpdate = Date.now();
    governorRequestRender('indian-history:render');
  }

  function textWidth(font, text) {
    const key = `${font}|${text}`;
    if (_textWidths.has(key)) return _textWidths.get(key);
    if (_measureCtx === undefined) {
      _measureCtx = globalThis.document?.createElement?.('canvas')?.getContext?.('2d') || null;
    }
    let width = text.length * 7;
    if (_measureCtx) {
      _measureCtx.font = font;
      width = _measureCtx.measureText(text).width;
    }
    _textWidths.set(key, width);
    return width;
  }

  function labelRecord(entity, font, text, h, kind, padX = 4) {
    return {
      entity,
      kind,
      position: entity.position.getValue(Cesium.JulianDate.now()),
      // +6 covers the fill-and-outline stroke on each side.
      w: textWidth(font, text) + padX + 6,
      h,
      optional: false,
      dx: null,
      dy: null,
      show: true,
    };
  }

  function candidatesFor(record) {
    if (record.kind === 'title') return [[0, 0], [0, -30], [0, 30]];
    if (record.kind === 'city') return cityLabelCandidates(record.w, record.h);
    return eventLabelCandidates(record.w, record.h);
  }

  /** Re-place labels for the current camera; cheap (tens of labels). */
  function layoutLabels() {
    const scene = _viewer?.scene;
    if (!_enabled || !_labels.length || typeof scene?.cartesianToCanvasCoordinates !== 'function') return;
    const now = globalThis.performance?.now?.() ?? Date.now();
    if (now - _lastLayoutMs < LAYOUT_THROTTLE_MS) return;
    _lastLayoutMs = now;

    const project = (position) => {
      const xy = scene.cartesianToCanvasCoordinates(position, _scratchXY);
      return xy ? { x: xy.x, y: xy.y } : null;
    };
    const obstacles = [];
    for (const position of _markerAnchors) {
      const xy = project(position);
      if (xy) obstacles.push({ ...xy, w: MARKER_BOX_PX, h: MARKER_BOX_PX });
    }
    const items = [];
    const byId = new Map();
    for (const record of _labels) {
      const xy = project(record.position);
      if (!xy) continue;
      byId.set(record.entity.id, record);
      items.push({
        id: record.entity.id, ...xy, w: record.w, h: record.h,
        candidates: candidatesFor(record), optional: record.optional,
      });
    }
    let changed = false;
    for (const [id, placement] of planLabelLayout(items, obstacles)) {
      const record = byId.get(id);
      if (record.dx === placement.dx && record.dy === placement.dy && record.show === placement.show) continue;
      record.dx = placement.dx;
      record.dy = placement.dy;
      record.show = placement.show;
      record.entity.label.pixelOffset = new Cesium.Cartesian2(placement.dx, placement.dy);
      record.entity.label.show = placement.show;
      changed = true;
    }
    if (changed) governorRequestRender('indian-history:declutter');
  }

  function installLayoutListeners() {
    const scene = _viewer?.scene;
    if (!_postRenderRemover && scene?.postRender?.addEventListener) {
      _postRenderRemover = scene.postRender.addEventListener(() => layoutLabels());
    }
    if (!_moveEndRemover && _viewer?.camera?.moveEnd?.addEventListener) {
      // The settled frame always gets a fresh layout, whatever the throttle said.
      _moveEndRemover = _viewer.camera.moveEnd.addEventListener(() => {
        _lastLayoutMs = -Infinity;
        layoutLabels();
      });
    }
  }

  function removeLayoutListeners() {
    if (_postRenderRemover) { _postRenderRemover(); _postRenderRemover = null; }
    if (_moveEndRemover) { _moveEndRemover(); _moveEndRemover = null; }
  }

  /** Publish the card for a picked entity, or clear it. */
  function showCard(entity) {
    if (!entity?.__gevHistory) {
      if (_card) {
        _card = null;
        _cardEntityId = null;
        overlayHost.clearSource(OVERLAY_SOURCE_ID);
        clearSelectedEntityContextForLayer(LAYER_ID);
        governorRequestRender('indian-history:deselect');
      }
      return;
    }
    const { kind, kingdomId, itemId } = entity.__gevHistory;
    const kingdom = kingdomById(kingdomId);
    if (!kingdom) return;
    let item = kingdom;
    if (kind === 'city') item = kingdom.cities.find((city) => city.id === itemId);
    if (kind === 'event') item = orderedEvents(kingdom).find((event) => event.id === itemId);
    if (!item) return;
    const point = kind === 'kingdom' ? kingdom.anchor : item;
    const position = Cesium.Cartesian3.fromDegrees(point.lon, point.lat);
    const card = createHistoryCardEntry(kind, kingdom, item, position);
    _card = { id: card.id, wiki: card.wiki };
    _cardEntityId = entity.id;
    overlayHost.setEntries(OVERLAY_SOURCE_ID, [{
      ...card,
      activate: () => openCardLink(),
    }]);
    overlayHost.setVisible(OVERLAY_SOURCE_ID, true);
    selectEntityContext(entity);
    governorRequestRender('indian-history:select');
  }

  function openCardLink() {
    if (!_card || !isWikipediaUrl(_card.wiki)) return false;
    openUrl(_card.wiki);
    return true;
  }

  function flyToKingdom(kingdom) {
    if (!_viewer?.camera || !kingdom) return;
    let west = 180; let south = 90; let east = -180; let north = -90;
    for (const extent of kingdom.extents) {
      for (const ring of extent.rings) {
        for (const [lon, lat] of ring) {
          west = Math.min(west, lon); east = Math.max(east, lon);
          south = Math.min(south, lat); north = Math.max(north, lat);
        }
      }
    }
    const altitude = Math.max(FLY_MIN_ALTITUDE_M, Math.max(east - west, north - south) * FLY_ALTITUDE_M_PER_DEG);
    _viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees((west + east) / 2, (south + north) / 2, altitude),
      duration: 1.6,
    });
  }

  function installClickHandler(viewer) {
    if (_clickHandler) return;
    _clickHandler = screenSpaceEventHandlerFactory(viewer);
    _clickHandler.setInputAction((click) => {
      if (!_enabled) return;
      // The card sits on top of the globe, so it wins over whatever is under it.
      const x = click.position?.x;
      const y = click.position?.y;
      const cardHit = _card && overlayHost.hitTest?.(x, y, { sourceId: OVERLAY_SOURCE_ID });
      if (cardHit) {
        if (isOverlayCloseHit(cardHit.rect, x, y)) showCard(null);
        else openCardLink();
        return;
      }
      const picked = viewer.scene.pick(click.position);
      const entity = picked?.id;
      if (entity?.__gevHistory) {
        // Clicking the marker whose card is open closes it again.
        if (_card && _cardEntityId === entity.id) {
          showCard(null);
          return;
        }
        viewer.selectedEntity = entity;
        showCard(entity);
        return;
      }
      // A sibling layer's pick (an aircraft, a camera) leaves our card alone;
      // anything else — empty space, terrain, or a 3D-tile feature — closes it.
      if (picked && isOwnedByOtherLayer(LAYER_ID, resolvePickId(picked))) return;
      showCard(null);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  const layer = {
    id: LAYER_ID,
    name: 'Indian History',
    icon: '🏛️',
    source: 'Curated · Wikipedia links',
    // Static dataset: update() runs once per enable and only redraws on change.
    updateInterval: 0,

    async init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(LAYER_ID);
      await viewer.dataSources.add(_dataSource);
      _dataSource.show = false;
    },

    async enable(viewer) {
      _enabled = true;
      if (viewer) _viewer = viewer;
      if (_dataSource) _dataSource.show = true;
      installClickHandler(_viewer);
      installLayoutListeners();
      registerPickOwner(LAYER_ID, (pickedId) => pickedId.startsWith('history:'));
      governorRequestRender('indian-history:enable');
      return true;
    },

    async disable() {
      _enabled = false;
      showCard(null);
      overlayHost.setVisible(OVERLAY_SOURCE_ID, false);
      if (_dataSource) _dataSource.show = false;
      if (_clickHandler) { _clickHandler.destroy(); _clickHandler = null; }
      removeLayoutListeners();
      unregisterPickOwner(LAYER_ID);
      governorRequestRender('indian-history:disable');
      return true;
    },

    async update() {
      if (_destroyed) return true;
      try {
        await data();
        _error = null;
        const kingdom = kingdomById(_kingdomId);
        if (!kingdom) throw new Error(`unknown kingdom ${_kingdomId}`);
        if (_renderedKingdomId !== kingdom.id) render(kingdom);
        notifyRowControls();
        return true;
      } catch (error) {
        _error = String(error?.message || error);
        console.warn('[indian-history] update failed:', error);
        return false;
      }
    },

    setParams(params = {}, { origin = 'programmatic' } = {}) {
      // `era` only changes which chips the row lists. It is deliberately not
      // a share-link option: the kingdom already implies its era.
      if (Object.hasOwn(params, 'era')) {
        if (!ERA_IDS.includes(params.era)) return false;
        _eraId = params.era;
        if (!Object.hasOwn(params, 'kingdom')) {
          notifyRowControls();
          return true;
        }
      }
      if (!Object.hasOwn(params, 'kingdom')) return true;
      const next = params.kingdom === null ? DEFAULT_KINGDOM : params.kingdom;
      if (!KINGDOM_IDS.includes(next)) return false;
      _kingdomId = next;
      _eraId = eraOfKingdom(next);
      const kingdom = kingdomById(next);
      if (_enabled && kingdom) {
        if (_renderedKingdomId !== next) render(kingdom);
        // Restores never move the camera; an explicit pick (even of the
        // already-shown kingdom) flies there.
        if (origin === 'user') flyToKingdom(kingdom);
      }
      notifyRowControls();
      return true;
    },

    getParams() {
      return { kingdom: _kingdomId };
    },

    getRowControls() {
      const selectedEra = eraOfKingdom(_kingdomId);
      const eraChips = HISTORY_ERAS.map((era) => {
        const count = KINGDOM_CHIPS.filter((chip) => chip.era === era.id).length;
        const open = era.id === _eraId;
        return {
          id: `era:${era.id}`,
          // The open era is highlighted; ● marks the era of the kingdom on the map.
          label: `${era.label}${era.id === selectedEra && !open ? ' ●' : ''}`,
          active: open,
          title: `${era.label} (${era.span}) · ${count} rulers`,
          params: { era: era.id },
        };
      });
      const kingdomChips = KINGDOM_CHIPS.filter((chip) => chip.era === _eraId).map((chip) => {
        const kingdom = kingdomById(chip.id);
        return {
          id: chip.id,
          label: chip.label,
          active: chip.id === _kingdomId,
          title: kingdom ? `${kingdom.name} · ${kingdom.period.label} — click to fly there` : chip.label,
          params: { kingdom: chip.id },
        };
      });
      return {
        chips: [...eraChips, ...kingdomChips],
        legend: _data ? historyLegend(kingdomById(_kingdomId)) : [],
      };
    },

    setRowControlsListener(listener) {
      _rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    getStats() {
      const kingdom = _data && !_error ? kingdomById(_kingdomId) : null;
      return {
        // The manager's row line is "<source> · <ago>", so the selected
        // kingdom rides in `source`.
        source: kingdom ? `${kingdom.name} · ${kingdom.period.label} · borders approximate` : layer.source,
        count: _count,
        lastUpdate: _lastUpdate,
        error: _error,
        status: _error ? 'unavailable' : 'nominal',
        meta: describeIndianHistoryState({
          kingdom,
          error: _error,
          loading: Boolean(_dataPromise) && !_data,
        }),
      };
    },

    async destroy(viewer) {
      _destroyed = true;
      await layer.disable();
      clearRendered();
      overlayHost.clearSource(OVERLAY_SOURCE_ID);
      removeEntityContextsForLayer(LAYER_ID);
      if (_dataSource && (viewer || _viewer)) (viewer || _viewer).dataSources.remove(_dataSource, true);
      _dataSource = null;
      _viewer = null;
      return true;
    },
  };

  return layer;
}

const indianHistoryLayer = createIndianHistoryLayer();
export default indianHistoryLayer;
