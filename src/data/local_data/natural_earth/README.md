# Natural Earth physical regions pack

Offline named-region polygons for the voice-annotation resolver
(`src/data/naturalEarthRegions.js`) — "outline the Alps" resolves to the real
range geometry with no network dependency.

| File | Source dataset | Features |
|------|----------------|----------|
| `regions.json` | `ne_10m_geography_regions_polys` (ranges, deserts, plateaus, peninsulas, islands, …) | 1,046 named |
| `marine.json` | `ne_10m_geography_marine_polys` (seas, gulfs, straits, bays, …) | 292 named |

**Source:** Natural Earth 10m physical vectors, via the canonical
[nvkelso/natural-earth-vector](https://github.com/nvkelso/natural-earth-vector)
GitHub repo, commit `ca96624a56bd078437bca8184e78163e5039ad19` (fetched
2026-07-28T01:36:39Z — exact provenance is in each file's `meta` header).

**License:** public domain (https://www.naturalearthdata.com/about/terms-of-use/).
No attribution legally required; we credit "Made with Natural Earth" anyway.
See DATA_SOURCES.md.

**Curation** (script not committed — parameters recorded in `meta.curation`):

- Named features only; the `Dragons-be-here` joke feature ("Null Island") dropped.
- Outer rings only (holes are irrelevant at country-scale outline zoom).
- Douglas-Peucker simplification at 0.01°, coordinates rounded to 3 decimals
  (~110 m), rings stored open (no closing duplicate vertex).
- MultiPolygon crumbs under 20 km² dropped (largest part always kept);
  rings that survive with fewer than 8 distinct vertices are midpoint-densified
  (shape-identical) so every ring has ≥8 vertices.
- Zero-area sliver artifacts dropped. Two marine features are ONLY slivers in
  the source and are therefore absent: **Drake Passage** and **Luzon Strait**.
- Result: 7.3 MB source → 2.5 MB pack (budget ≤3 MB, enforced by
  `src/data/naturalEarthRegions.test.mjs`).

Duplicate names exist upstream (two "Cordillera Oriental", a sliver + real
"Canadian Shield", …); the lookup module resolves ties by largest area.

## countries.json

ISO 3166-1 alpha-2 country boundaries, built by `scripts/build-country-polygons.mjs`
from Natural Earth 1:10m `ne_10m_admin_0_countries` (public domain).
233 countries, 2,945 outer rings, 2.95 MB. Loaded lazily by the News layer, which
uses it twice: to decide which country the camera is over, and to scatter that
country's pins inside its own border.

10m rather than 50m, measured rather than assumed. Against 14 real city
coordinates, 50m placed only 7 inside their own country — New York, Miami,
Kochi, Hong Kong and San Francisco all fell in the sea, because at 1:50,000,000
the coastline is generalised past those harbours. 10m gets 12 of 14 for 2.95 MB
instead of 1.16 MB. Miami and Venice still miss; `newsPlacement.countryAt()`
covers that with a nearest-country fallback, which has to exist anyway for a
camera parked offshore.

Curation: outer rings only (holes discarded), Douglas-Peucker at 0.01 degrees,
coordinates to 3 decimals, parts under 20 km2 dropped, sorted by ISO code for a
stable diff. Rings carry precomputed areas so pin scatter can be weighted by
landmass rather than by ring order.
