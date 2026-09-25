# Test fixtures

- `tomtom-flow-austin-12-935-1686.pbf` — one real TomTom traffic-flow vector
  tile (Mapbox Vector Tile protobuf, layer `"Traffic flow"`), downtown Austin
  z12 x935 y1686, captured 2026-07-16 from
  `api.tomtom.com/traffic/map/4/tile/flow/relative/12/935/1686.pbf`
  (22,980 bytes). Used ONLY by `src/data/flowTiles.test.mjs` to pin MVT
  decoding offline — it is a point-in-time congestion snapshot, not a bundled
  data layer, and is never served to the app. © TomTom.

- `gdelt-doc-artlist-synthetic.json` — a **synthetic** GDELT DOC 2.0 `artlist`
  response (32 records, India, 2026-08-24) in the exact wire shape the real
  endpoint returns. Hand-built, not captured: it encodes one heavily
  syndicated story (14 outlets), one mid-sized (6), one small (3), one pair,
  three singles, and three deliberately malformed records. Used by
  `src/data/newsPolicy.test.mjs` to pin the clustering thresholds, and by
  `scripts/news-ingest.mjs --fixture=` to exercise the whole ingest path with
  no network. Replace it with a captured response if you ever need to pin
  GDELT's real field shape.
