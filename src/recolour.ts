import type { Map as MapLibreMap } from 'maplibre-gl';

/**
 * Colours applied over OpenFreeMap's Dark style, which on its own has near-black land, an
 * almost identical sea, faint borders and mid-grey labels. Used for the Graphite and
 * Midnight Blue basemaps.
 */
export interface Recolour {
  land: string;
  water: string;
  /** Country borders. */
  border: string;
  /** State and province borders. */
  state: string;
  /**
   * Borders at sea (territorial waters, maritime boundaries). The light OpenFreeMap styles
   * don't draw these, so they're kept close to the sea colour here.
   */
  maritime: string;
  park: string;
  /** Built-up areas. */
  residential: string;
  /** Minor roads, and motorways/major roads (brighter). */
  road: string;
  major: string;
  labels: { places: string; other: string; halo: string };
}

/** Repaints the basemap's own layers. Call on `style.load`, before adding other layers. */
export function applyRecolour(map: MapLibreMap, c: Recolour) {
  for (const l of map.getStyle().layers) {
    const id = l.id;
    const set = (prop: string, v: unknown) => map.setPaintProperty(id, prop as 'line-color', v as string);
    const atSea = (onLand: string) => ['case', ['==', ['get', 'maritime'], 1], c.maritime, onLand];
    if (l.type === 'symbol') {
      const place = 'source-layer' in l && l['source-layer'] === 'place';
      set('text-color', place ? c.labels.places : c.labels.other);
      set('text-halo-color', c.labels.halo);
    } else if (id === 'background') set('background-color', c.land);
    else if (id === 'water') set('fill-color', c.water);
    else if (id === 'waterway') set('line-color', c.water);
    else if (id.startsWith('landcover_ice') || id.startsWith('landcover_glacier')) set('fill-color', c.land);
    else if (id === 'landuse_park' || id === 'landcover_wood') set('fill-color', c.park);
    else if (id === 'landuse_residential') set('fill-color', c.residential);
    else if (id.startsWith('boundary_country')) {
      set('line-color', atSea(c.border));
      set('line-blur', 0.2);
    } else if (id.startsWith('boundary_state')) set('line-color', atSea(c.state));
    else if (id.startsWith('highway') && l.type === 'line') {
      set('line-color', /motorway|major/.test(id) ? c.major : c.road);
    }
  }
}

/** Raster imagery over the basemap that fades out between `fade[0]` and `fade[1]` zoom. */
export function addOverlay(
  map: MapLibreMap,
  o: { tiles: string; maxzoom: number; attribution: string; fade: [number, number] },
) {
  map.addSource('overlay', { type: 'raster', tiles: [o.tiles], tileSize: 256, maxzoom: o.maxzoom, attribution: o.attribution });
  map.addLayer({
    id: 'overlay',
    type: 'raster',
    source: 'overlay',
    maxzoom: o.fade[1] + 0.01, // not drawn (or fetched) once fully faded
    paint: { 'raster-opacity': ['interpolate', ['linear'], ['zoom'], o.fade[0], 1, o.fade[1], 0], 'raster-fade-duration': 0 },
  });
}
