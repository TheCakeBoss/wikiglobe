# Wikipedia Globe

A static site that shows a Wikipedia article next to a 3D globe with a pin for every
place the article links to.

```bash
npm install
npm run dev      # http://localhost:5173/?page=Gallipoli_campaign
npm run build    # typecheck + production build into dist/
```

## Layout

| File | What it does |
| --- | --- |
| `src/config.ts` | Basemap styles, terrain tiles, API endpoints, cache TTL, large-region thresholds |
| `src/wiki.ts` | Wikimedia API calls: opensearch, primary coordinate, linked places (with `continue`), summaries |
| `src/cache.ts` | Memory cache, localStorage for small entries, and gzip-compressed IndexedDB for article HTML and places (24h expiry, ~300 articles) |
| `src/prefetch.ts` | Starts loading an article when a link to it is hovered or focused for 200 ms (two at a time at most) |
| `src/filter.ts` | Hides countries, continents and anything with `dim` ≥ 500 km, unless they are all an article links to |
| `src/article.ts` | Fetches Parsoid HTML, sanitises it (DOMPurify), strips navboxes/banners, rewrites links to open in-app |
| `src/relevance.ts` | Scores places from the rendered article; finds context snippets and first mentions |
| `src/globe.ts` | MapLibre globe: clustered pins, highlight rings, hover/click cards, idle spin |
| `src/timeline.ts` | Finds years in the article text and draws the timeline under the globe |
| `src/sentence.ts` | Sentence lookups for snippets and "mentioned in the same sentence" |
| `src/mapSettings.ts` | Map button: globe/flat view, basemap style, hill shading, pin colour (remembered per browser) |
| `src/layout.ts` | Draggable dividers (place-list width; article vs globe) and the collapsible place list, remembered per browser |
| `src/history.ts` | Recently viewed articles under the place list (last 50, per browser) |
| `src/search.ts` | Search box with autocomplete; accepts titles or full Wikipedia URLs |
| `src/main.ts` | URL state (`?page=`, plus `n=` when not default), loading / empty / not-found states |

## Relevance score

Only links in the article body count. Reference lists, sidebars, the lead's disambiguation
hatnotes and trailing sections (See also, Notes, References, External links...) are ignored.
Places linked only from those are hidden.

| Signal | Points |
| --- | --- |
| Each link in the body | 1 |
| Linked in the lead (outside the infobox) | +3 |
| Linked in the infobox | +2 |
| Target of a section's "Main article:" hatnote | +2 |
| Each plain-text mention of the name (first letter case-sensitive, max 10) | +0.5 |

Weights live at the top of `src/relevance.ts`. Pins scale in size and opacity by score
(square root, relative to the pins shown).

Basemaps and pin colours are listed in `MAP_STYLES` and `PIN_COLORS` in `src/config.ts`;
the Map button on the globe switches between them, between globe and flat views, and turns
hill shading on or off. All basemaps are free and keyless: OpenFreeMap (Colourful, the default, is its Liberty
style; Light; plus Graphite and Midnight Blue, which repaint its Dark style via
`src/recolour.ts`) and NASA GIBS imagery (Blue Marble, Night Lights; public domain, sharp
only to about country level; Night Lights fades into Midnight Blue past zoom 7.5–8.5 via
the `overlay` option). OpenFreeMap was chosen over VersaTiles for its global CDN. Hill shading uses the free AWS Terrain Tiles; it
is drawn under the sea (the data includes the sea floor) and skipped on the NASA styles.
Hovering a style shows a thumbnail from `public/map-previews/` (one WebP per style id, plus
`terrain.webp`: the same 480×300 view of Port Phillip Bay with sample pins); add one when
adding a style. Add `MAP_ATTRIBUTION` if a new style doesn't declare its own credits.

Wikipedia requests send no custom headers: an `Api-User-Agent` header would make the
browser send a CORS preflight before every request (~0.3 s each). The browser's `Origin`
header identifies the site to Wikimedia.

## Status

- **Phase 1 (done):** search + autocomplete, URL state, linked places with coordinates,
  non-Earth/large-region filtering, globe with pins, lazy hover cards.
- **Phase 2 (done):** article rendering, relevance scoring + top N, context snippets, link
  rewriting, click a pin to scroll to its mention.
- **Phase 3 (done, desktop):** place list with the Top N slider, draggable divider,
  timeline of the most-mentioned years, two-way hover between article, globe, list and
  timeline, clustering, deploy config. Mobile layout not revisited yet.

## Deploy

- **GitHub Pages:** push to `main`; `.github/workflows/deploy.yml` builds and publishes.
  One-time: repo Settings → Pages → Source: GitHub Actions.
- **Netlify:** connect the repo; `netlify.toml` has the build settings.
