/**
 * @module wikiPulsePlacement
 * @description Where a Wiki Pulse blip goes.
 *
 * Unlike `newsPlacement.js`, which scatters a story inside the country GDELT
 * already told us it happened in, a Wikimedia recentchange event carries no
 * location at all — not the editor's, not the article subject's. Inventing
 * one from the wiki's language edition would assert something false (a French
 * Wikipedia edit is not "in France"), so this module does not try. It picks
 * an arbitrary country, weighted by land area so a blip is no more likely to
 * land on a sliver than on a continent, then reuses `newsPlacement.js`'s own
 * in-country scatter unchanged. The result is honestly decorative: a pulse of
 * global activity, not a map of anything real. Callers must say so on the
 * card — see `wikiPulsePresentation.js`.
 *
 * Determinism is still load-bearing for the same reason it is in News: the
 * same event id must always land in the same place, so a share link or a
 * reload does not make a blip wander.
 */

import { hashSeed, mulberry32, placeArticle } from './newsPlacement.js';

export { hashSeed, mulberry32, placeArticle };

/**
 * Choose a country, weighted by its total land area, using the seeded PRNG.
 *
 * Mirrors `pickRingByArea`'s weighting, one level up: there a country's own
 * rings compete by area, here whole countries do, so a blip is not equally
 * likely to land in Vatican City as in Russia.
 * @param {Array<object>} countries Loaded country records (`iso`, `rings`, `areas`).
 * @param {() => number} random Seeded generator.
 * @returns {object|null} The chosen country record, or null if none are usable.
 */
export function pickCountryByArea(countries, random) {
  const list = Array.isArray(countries) ? countries : [];
  if (!list.length) return null;

  const totals = list.map((country) => {
    const areas = Array.isArray(country?.areas) ? country.areas : [];
    return areas.reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
  });
  const total = totals.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return list[0] || null;

  let target = random() * total;
  for (let i = 0; i < list.length; i++) {
    target -= totals[i];
    if (target <= 0) return list[i];
  }
  return list[list.length - 1];
}

/**
 * Deterministic, decorative position for one Wiki Pulse event.
 *
 * Seeds one PRNG from the event id, spends its first draw picking a country
 * by area, then hands off to `placeArticle` (a fresh PRNG of its own, same
 * seed) for the in-country scatter — identical machinery to News, minus the
 * part where News actually knows where the story happened.
 * @param {{id: string}} event Row with a stable `id`.
 * @param {Array<object>} countries Loaded country records.
 * @returns {{lat: number, lon: number, countryIso: string, countryName: string}|null} Position, or null if it cannot be placed.
 */
export function placeEvent(event, countries) {
  const id = String(event?.id ?? '');
  if (!id || !Array.isArray(countries) || !countries.length) return null;

  const random = mulberry32(hashSeed(id));
  const country = pickCountryByArea(countries, random);
  if (!country) return null;

  const position = placeArticle({ id }, country);
  if (!position) return null;

  return {
    lat: position.lat,
    lon: position.lon,
    countryIso: country.iso ?? null,
    countryName: country.name ?? null,
  };
}
