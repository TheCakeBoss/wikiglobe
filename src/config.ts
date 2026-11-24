/**
 * App-wide settings. The basemap lives here so it can be swapped for satellite
 * imagery later (e.g. a MapTiler style URL with a key) without touching other code.
 */
export const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/**
 * Extra credit for the map's attribution control. The OpenFreeMap style already declares
 * its own (OpenFreeMap, OpenMapTiles, OpenStreetMap); set this if a future style doesn't.
 */
export const MAP_ATTRIBUTION: string | undefined = undefined;

export const WIKI_HOST = 'https://en.wikipedia.org';
export const ACTION_API = `${WIKI_HOST}/w/api.php`;
export const REST_API = `${WIKI_HOST}/api/rest_v1`;

/**
 * Sent as `Api-User-Agent` (browsers won't let us set User-Agent).
 * Wikimedia etiquette asks for a way to reach the operator: point this at the
 * project's public repo or site once it's deployed.
 */
export const API_USER_AGENT = 'WikipediaGlobe/0.1 (static web app; https://github.com/)';

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
