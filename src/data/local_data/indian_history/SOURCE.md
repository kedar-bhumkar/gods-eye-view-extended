# Indian History kingdoms — provenance & license

`kingdoms.json` backs the **Indian History** data layer (`src/data/indianHistory.js`).

## What it is

49 powers that ruled in the subcontinent, from the Nandas (4th century BCE)
to the British Raj (1947), grouped into five eras for the layer's chips:

- **Ancient:** Nanda, Maurya, Pandya, Indo-Greek, Satavahana, Kushan, Western Satraps
- **Classical:** Vakataka, Pallava, Gupta, Alchon Huns, Chalukya (Badami), Harsha, Karkota
- **Early medieval:** Arab Sindh, Gurjara-Pratihara, Pala, Rashtrakuta, Paramara
  (Raja Bhoja), Hindu Shahi, Chola, Ghaznavid, Hoysala, Eastern Ganga, Kakatiya, Ghurid
- **Late medieval:** the Delhi Sultanate's Mamluk, Khalji, Tughlaq, Sayyid and Lodi
  dynasties, Vijayanagara, Bahmani, and the Bengal, Malwa, Gujarat and Deccan sultanates
- **Early modern:** Portuguese, Mughal, Sur, Dutch, French, Maratha, Hyderabad
  (Nizams), Durrani, East India Company, Mysore (Hyder Ali and Tipu), Sikh, British Raj

Each has an approximate territorial extent, key cities, and dated key events,
each linked to its English Wikipedia article. Summaries try to describe each
power on its own terms — e.g. the Palas were Buddhist, and raids such as
Mahmud's or Nader Shah's are described plainly — without taking sides.

## Provenance

- **Extents** are original, hand-traced, deliberately coarse polygons (20–40
  vertices) drawn for this project. They follow the broad consensus shown in the
  maps and text of each kingdom's Wikipedia article and the standard historical
  atlases those articles cite. They are **not** copied or traced from any
  third-party GeoJSON or map image.
- **Cities and events** are hand-written summaries of well-attested facts, with
  coordinates for the modern site (or its best-known location).

Ancient borders are uncertain and contested — the Nanda extent is especially
inferential, and the Gupta outline shows directly ruled territory only (not
tributaries or allies such as the Vakatakas). Each extent shows one moment,
usually the peak, and its `label` says which. Long-lived dynasties (Pandya,
Chola, Mughal, Maratha) moved a great deal; one outline cannot show that. Tiny
European enclaves are drawn slightly enlarged so they are visible, and extents
for empires reaching beyond the map (Ghaznavid, Durrani) omit their western
lands. Where an
event's place is itself uncertain (e.g. Pulakeshin II's victory "on the
Narmada") the summary says the marker is indicative. The layer labels every
extent "approximate" for these reasons.

## License

Authored for this repository; released under the repository's MIT license.
Wikipedia is linked, not copied.

## File format

```jsonc
{ "kingdoms": [{
  "id", "name", "period": { "start", "end", "label" },   // years: negative = BCE
  "color", "wiki", "summary", "anchor": { "lat", "lon" },
  "extents": [{ "id", "label", "rings": [[[lon, lat], ...]],      // closed rings
                "holes"?: [[[lon, lat], ...]] }],               // cut from the single ring
  "cities": [{ "id", "name", "role": "capital|provincial|city", "lat", "lon", "note", "wiki" }],
  "events": [{ "id", "year", "circa"?, "title", "lat", "lon", "summary", "wiki" }]
}] }
```

Adding a kingdom means adding an entry here (the file stays in chronological
order of `period.start`) and a matching `KINGDOM_CHIPS` entry — with its `era` and a new,
never-reused one- or two-character share-link `code` — in
`src/data/indianHistoryPresentation.js`. The share-link enum in
`layerState.js` is built from that list. Tests enforce the ordering, the id
match, unique codes, and that every title anchor and capital sits inside its
extent.
