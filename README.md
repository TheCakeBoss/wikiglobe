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
| `src/globe.ts` | MapLibre globe, pins, hover/click cards, idle spin |
| `src/search.ts` | Search box with autocomplete; accepts titles or full Wikipedia URLs |
| `src/main.ts` | URL state (`?page=`), loading / empty / not-found states |

Change the basemap by editing `MAP_STYLE_URL` (and `MAP_ATTRIBUTION` if the new style
doesn't declare its own credits).

Before deploying, set `API_USER_AGENT` in `src/config.ts` to include the public repo or
site URL, as Wikimedia's API etiquette asks.

## Status

- **Phase 1 (done):** search + autocomplete, URL state, linked places with coordinates,
  non-Earth/large-region filtering, globe with pins, lazy hover cards.
- **Phase 2:** article rendering, relevance scoring + top N, context snippets, link rewriting.
- **Phase 3:** two-way hover, clustering, place list, mobile polish, deploy config.
