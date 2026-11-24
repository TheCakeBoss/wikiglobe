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
| `src/config.ts` | Basemap style URL, API endpoints, `Api-User-Agent`, cache TTL, large-region thresholds |
| `src/wiki.ts` | Wikimedia API calls: opensearch, primary coordinate, linked places (with `continue`), summaries |
| `src/cache.ts` | Memory + localStorage cache (24h expiry, evicts oldest on quota errors) |
| `src/filter.ts` | Hides countries, continents and anything with `dim` ≥ 500 km unless toggled on |
| `src/article.ts` | Fetches Parsoid HTML, sanitises it (DOMPurify), strips navboxes/banners, rewrites links to open in-app |
| `src/relevance.ts` | Scores places from the rendered article; finds context snippets and first mentions |
| `src/globe.ts` | MapLibre globe, pins, hover/click cards, idle spin |
| `src/search.ts` | Search box with autocomplete; accepts titles or full Wikipedia URLs |
| `src/main.ts` | URL state (`?page=`, plus `n=` and `large=1` when not default), loading / empty / not-found states |

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

Change the basemap by editing `MAP_STYLE_URL` (and `MAP_ATTRIBUTION` if the new style
doesn't declare its own credits).

Before deploying, set `API_USER_AGENT` in `src/config.ts` to include the public repo or
site URL, as Wikimedia's API etiquette asks.

## Status

- **Phase 1 (done):** search + autocomplete, URL state, linked places with coordinates,
  non-Earth/large-region filtering, globe with pins, lazy hover cards.
- **Phase 2 (done):** article rendering, relevance scoring + top N, context snippets, link
  rewriting, click a pin to scroll to its mention.
- **Phase 3:** two-way hover, clustering, place list, mobile polish, deploy config.
