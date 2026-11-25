import type { StyleSpecification } from 'maplibre-gl';
import type { Recolour } from './recolour';

/**
 * App-wide settings. Basemaps live here so more can be added later without touching
 * other code. Every basemap must be free to use without a key.
 */
export interface MapStyle {
  id: string;
  label: string;
  /** A style URL, or a full style for raster imagery. */
  style: string | StyleSpecification;
  /** Swatch colours for the picker: [land, water]. */
  swatch: [string, string];
  /** Shown under the hover preview in the Map picker. */
  note?: string;
  /** Repaints the style's own land, sea, borders, roads and labels (see recolour.ts). */
  recolour?: Recolour;
  /**
   * Raster imagery drawn over the basemap that fades out between two zooms, revealing the
   * basemap underneath (Night Lights over Midnight Blue).
   */
  overlay?: { tiles: string; maxzoom: number; attribution: string; fade: [number, number] };
  /** Imagery that already shows relief (or would be washed out): hill shading is skipped. */
  noShading?: boolean;
  /** Font for the cluster counts; it must exist on the style's glyph server. */
  font?: string;
}

/** OpenFreeMap's glyph server, for raster styles that have no labels of their own. */
const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

/** A style made of one raster tile layer. */
const raster = (tiles: string, attribution: string, maxzoom: number, background: string): StyleSpecification => ({
  version: 8,
  glyphs: GLYPHS,
  sources: { imagery: { type: 'raster', tiles: [tiles], tileSize: 256, maxzoom, attribution } },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': background } },
    { id: 'imagery', type: 'raster', source: 'imagery' },
  ],
});

const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
const NASA_CREDIT = '<a href="https://earthdata.nasa.gov/gibs" target="_blank" rel="noopener">NASA GIBS</a>';

// Graphite and Midnight Blue repaint OpenFreeMap's Dark style.
const OFM_DARK = 'https://tiles.openfreemap.org/styles/dark';
const DARK_LABELS = { places: '#dcdcdc', other: '#a9a9a9', halo: 'rgba(0, 0, 0, 0.85)' };

const MIDNIGHT: Recolour = {
  land: '#232c3d', water: '#0a1120', border: '#8193b8', state: '#4a5672', maritime: '#18223a', park: '#243241',
  residential: '#2c3850', road: '#4a5a7e', major: '#7083ad',
  labels: DARK_LABELS,
};

export const MAP_STYLES: MapStyle[] = [
  // OpenFreeMap throughout: its tiles come from a global CDN (15–35 ms per tile from
  // Melbourne, against ~250 ms from VersaTiles' single server in Germany).
  { id: 'colorful', label: 'Colourful', style: 'https://tiles.openfreemap.org/styles/liberty', swatch: ['#f2efe9', '#9ec6e8'] },
  { id: 'positron', label: 'Light', style: 'https://tiles.openfreemap.org/styles/positron', swatch: ['#f2f3f0', '#c2c8ca'] },
  {
    id: 'graphite', label: 'Graphite', style: OFM_DARK, swatch: ['#3a3a3c', '#111113'],
    recolour: {
      land: '#3a3a3c', water: '#111113', border: '#d0d0d0', state: '#6a6a6e', maritime: '#26262a', park: '#35393a',
      residential: '#424245', road: '#626268', major: '#8d8d94',
      labels: DARK_LABELS,
    },
  },
  { id: 'midnight', label: 'Midnight Blue', style: OFM_DARK, swatch: ['#232c3d', '#0a1120'], recolour: MIDNIGHT },
  {
    id: 'blue-marble', label: 'Blue Marble', swatch: ['#5a7240', '#0e2c5c'],
    note: 'NASA imagery. Sharp to about country level, blurry when zoomed in close.',
    noShading: true,
    style: raster(`${GIBS}/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg`, NASA_CREDIT, 8, '#0e2c5c'),
  },
  {
    // NASA only publishes this to zoom 8 (~500 m per pixel), so closer in it fades into
    // Midnight Blue's streets and labels.
    id: 'night-lights', label: 'Night Lights', swatch: ['#0b0d1c', '#e8c36a'],
    note: 'NASA city lights at night. Fades into Midnight Blue streets once you zoom in past state level.',
    noShading: true,
    style: OFM_DARK,
    recolour: MIDNIGHT,
    overlay: {
      tiles: `${GIBS}/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png`,
      maxzoom: 8,
      attribution: NASA_CREDIT,
      fade: [7.5, 8.5],
    },
  },
];
export const DEFAULT_MAP_STYLE = 'colorful';

/** Pin colour choices. The first is the default. */
export const PIN_COLORS: { id: string; label: string; hex: string }[] = [
  { id: 'red', label: 'Red', hex: '#d9381e' },
  { id: 'orange', label: 'Orange', hex: '#e8730c' },
  { id: 'pink', label: 'Pink', hex: '#d6246e' },
  { id: 'violet', label: 'Violet', hex: '#7b3fe4' },
  { id: 'blue', label: 'Blue', hex: '#1f6feb' },
  { id: 'teal', label: 'Teal', hex: '#0f9488' },
];

/**
 * Extra credit for the map's attribution control. The OpenFreeMap style already declares
 * its own (OpenFreeMap, OpenMapTiles, OpenStreetMap); set this if a future style doesn't.
 */
/** Free elevation tiles (AWS Terrain Tiles, Terrarium encoding) for the terrain shading option. */
export const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const TERRAIN_ATTRIBUTION = 'Terrain: Mapzen, <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">AWS Open Data</a>';

export const MAP_ATTRIBUTION: string | undefined = undefined;

export const WIKI_HOST = 'https://en.wikipedia.org';
export const ACTION_API = `${WIKI_HOST}/w/api.php`;
export const REST_API = `${WIKI_HOST}/api/rest_v1`;
/**
 * MediaWiki REST API, which replaces /api/rest_v1 for article HTML (the old address now
 * just redirects here). Redirect titles answer with a 307 to the target, which fetch follows.
 */
export const PAGE_REST_API = `${WIKI_HOST}/w/rest.php/v1/page`;

/*
 * Wikipedia requests deliberately send no custom headers (such as Api-User-Agent): any
 * custom header makes the browser send a CORS preflight before every request, which
 * measured at ~0.3 s extra per request. Browsers already send the site's Origin, which
 * identifies the app to Wikimedia.
 */

/** localStorage entries older than this are refetched. */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const CACHE_PREFIX = 'wg:v1:';

/**
 * Coordinates with a `dim` (rough object size, metres) at or above this are treated
 * as "large regions" and hidden by default, like countries.
 */
export const LARGE_DIM_METRES = 500_000;

/** Coordinate `type` values hidden by default (shown with the "large regions" toggle). */
export const LARGE_TYPES = new Set(['country', 'continent']);
