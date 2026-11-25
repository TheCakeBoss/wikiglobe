import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre finds its worker next to its own module, which breaks once Vite pre-bundles it.
// The worker file is self-contained, so hand Vite the URL directly (works in dev and build).
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { addOverlay, applyRecolour } from './recolour';
import { MAP_ATTRIBUTION, TERRAIN_ATTRIBUTION, TERRAIN_TILES, type MapStyle } from './config';
import { getSummary, wikipediaUrl, type Place } from './wiki';

export interface GlobeOptions {
  /** The user chose to open a place's article inside the app. */
  onOpen: (title: string) => void;
  /** A pin was clicked (the camera is already flying to it). */
  onSelect?: (title: string) => void;
  /** The pointer is over these places on the globe (a pin, or a cluster's places); [] on leave. */
  onHover?: (titles: string[]) => void;
  /** The user dismissed the pinned card (clicked empty globe). */
  onDeselect?: () => void;
  /** Initial basemap, projection, pin colour and terrain shading. */
  style: MapStyle;
  terrain?: boolean;
  projection?: Projection;
  pinColor?: string;
}

export type Projection = 'globe' | 'mercator';

/** A pin: a place plus optional relevance weight (0..1) and context sentence. */
export interface GlobePlace extends Place {
  weight?: number;
  snippet?: string;
}

maplibregl.setWorkerUrl(workerUrl);

/** Degrees of longitude per second at whole-globe zoom. */
const SPIN_DEG_PER_SEC = 4;
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
/** Layers whose colour follows the pin colour setting. */
const PIN_PAINT: [string, string][] = [
  ['clusters', 'circle-color'],
  ['places', 'circle-color'],
  ['highlight-ring', 'circle-color'],
  ['highlight-ring', 'circle-stroke-color'],
  ['highlight-dot', 'circle-color'],
];
/** The article's own location: blue, or amber when the pins are a cool colour (shows on light and dark maps). */
const primaryColor = (pin: string) => (['#1f6feb', '#7b3fe4', '#0f9488'].includes(pin) ? '#e0a100' : '#1f5fbf');

/** Cluster-count font on OpenFreeMap's glyph server (styles can override it). */
const DEFAULT_FONT = 'Noto Sans Bold';

const point = (p: Place, properties: Record<string, unknown> = {}): GeoJSON.Feature => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
  properties,
});

export class Globe {
  private map: maplibregl.Map;
  private ready: Promise<void>;
  private byTitle = new Map<string, GlobePlace>();
  private popup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    maxWidth: '320px',
    offset: 12,
    className: 'place-popup',
  });
  /** Title (or `cluster:<id>`) whose card is showing. */
  private cardKey: string | null = null;
  /** A clicked pin keeps its card until the user clicks elsewhere. */
  private sticky = false;
  private hoverKey: string | null = null;
  private spinning = false;
  /** Set once the user drags, zooms or clicks the globe; cleared by placeCamera(). */
  private interacted = false;
  private lastFrame = 0;
  // Our data, kept so it can be re-added when the basemap style changes.
  private placesData: GeoJSON.FeatureCollection = EMPTY;
  private primaryData: GeoJSON.FeatureCollection | GeoJSON.Feature = EMPTY;
  private highlightData: GeoJSON.FeatureCollection = EMPTY;
  private projection: Projection;
  private pin: string;
  private font: string;
  private recolour: MapStyle['recolour'];
  private overlay: MapStyle['overlay'];
  private noShading: boolean;
  private terrain: boolean;

  constructor(container: HTMLElement, private opts: GlobeOptions) {
    this.projection = opts.projection ?? 'globe';
    this.pin = opts.pinColor ?? '#d9381e';
    this.font = opts.style.font ?? DEFAULT_FONT;
    this.recolour = opts.style.recolour;
    this.overlay = opts.style.overlay;
    this.noShading = !!opts.style.noShading;
    this.terrain = opts.terrain ?? false;
    this.map = new maplibregl.Map({
      container,
      style: opts.style.style,
      center: [20, 20],
      zoom: 1.4,
      attributionControl: false,
      renderWorldCopies: false,
    });
    this.map.addControl(
      new maplibregl.AttributionControl({ compact: true, customAttribution: MAP_ATTRIBUTION }),
      'bottom-right',
    );
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    if (import.meta.env.DEV) (window as any).__map = this.map;

    // `style.load` (not `load`, which waits for every tile) is enough to add our own layers.
    // It fires again after setBasemap(), which replaces the whole style, so re-add them each time.
    this.ready = new Promise((resolve) => this.map.on('style.load', () => {
      this.map.setProjection({ type: this.projection });
      this.addLayers();
      resolve();
    }));
    this.addEvents();

    // Any direct interaction stops the idle spin.
    for (const ev of ['pointerdown', 'wheel', 'touchstart', 'keydown']) {
      container.addEventListener(ev, () => {
        this.interacted = true;
        this.stopSpin();
      }, { passive: true, capture: true });
    }
    // The divider and list toggle resize the globe without a window resize.
    new ResizeObserver(() => this.map.resize()).observe(container);
  }

  private addLayers() {
    const m = this.map;
    if (this.recolour) applyRecolour(m, this.recolour);
    if (this.overlay) addOverlay(m, this.overlay);
    if (this.terrain && !this.noShading) this.addTerrain();
    m.addSource('places', {
      type: 'geojson',
      data: this.placesData,
      cluster: true,
      clusterRadius: 36,
      clusterMaxZoom: 7,
      clusterProperties: { wmax: ['max', ['get', 'w']] },
    });
    m.addSource('primary', { type: 'geojson', data: this.primaryData });
    m.addSource('highlight', { type: 'geojson', data: this.highlightData });

    // Clusters: size by count, opacity by their most relevant place.
    m.addLayer({
      id: 'clusters',
      type: 'circle',
      source: 'places',
      filter: ['has', 'point_count'],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['get', 'point_count'], 2, 11, 10, 15, 40, 21, 150, 28],
        'circle-color': this.pin,
        'circle-opacity': ['+', 0.55, ['*', ['get', 'wmax'], 0.4]],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      },
    });
    m.addLayer({
      id: 'cluster-count',
      type: 'symbol',
      source: 'places',
      filter: ['has', 'point_count'],
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        'text-font': [this.font],
        'text-size': 12,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': '#ffffff' },
    });
    // Single pins: size and opacity scale with relevance (`w`, 0..1).
    m.addLayer({
      id: 'places',
      type: 'circle',
      source: 'places',
      filter: ['!', ['has', 'point_count']],
      layout: { 'circle-sort-key': ['get', 'w'] },
      paint: {
        'circle-radius': [
          'interpolate', ['linear'], ['zoom'],
          1, ['+', 3, ['*', ['get', 'w'], 5]],
          8, ['+', 5, ['*', ['get', 'w'], 7]],
        ],
        'circle-color': this.pin,
        'circle-opacity': ['+', 0.45, ['*', ['get', 'w'], 0.5]],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.25,
        'circle-stroke-opacity': ['+', 0.6, ['*', ['get', 'w'], 0.4]],
      },
    });
    m.addLayer({
      id: 'primary',
      type: 'circle',
      source: 'primary',
      paint: {
        'circle-radius': 8,
        'circle-color': primaryColor(this.pin),
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 3,
      },
    });
    // Highlights sit above clusters, so a place inside a cluster still shows where it is.
    m.addLayer({
      id: 'highlight-ring',
      type: 'circle',
      source: 'highlight',
      paint: {
        'circle-radius': 14,
        'circle-color': this.pin,
        'circle-opacity': 0.18,
        'circle-stroke-color': this.pin,
        'circle-stroke-width': 2.5,
      },
    });
    m.addLayer({
      id: 'highlight-dot',
      type: 'circle',
      source: 'highlight',
      paint: {
        'circle-radius': 6,
        'circle-color': this.pin,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      },
    });
  }

  /** Pointer events. Layer-bound listeners survive style changes, so register them once. */
  private addEvents() {
    const m = this.map;
    m.on('mousemove', 'places', (e) => this.hoverPin(e.features?.[0]));
    m.on('mousemove', 'clusters', (e) => this.hoverCluster(e.features?.[0]));
    m.on('mouseleave', 'places', () => this.leave());
    m.on('mouseleave', 'clusters', () => this.leave());
    m.on('click', 'places', (e) => {
      const t = e.features?.[0]?.properties?.title as string | undefined;
      if (t) this.select(t);
    });
    m.on('click', 'clusters', (e) => this.zoomIntoCluster(e.features?.[0]));
    m.on('click', (e) => {
      // A click on empty globe clears the pinned card.
      if (!m.queryRenderedFeatures(e.point, { layers: ['places', 'clusters'] }).length && this.sticky) {
        this.unpin();
        this.opts.onDeselect?.();
      }
    });
  }

  /** Replace the pins without moving the camera. */
  async setPlaces(places: GlobePlace[], primary: { lat: number; lon: number } | undefined) {
    await this.ready;
    this.unpin();
    this.byTitle = new Map(places.map((p) => [p.title, p]));
    this.placesData = {
      type: 'FeatureCollection',
      features: places.map((p) => point(p, { title: p.title, w: p.weight ?? 0.5 })),
    };
    this.primaryData = primary ? point(primary as Place) : EMPTY;
    this.source('places')?.setData(this.placesData);
    this.source('primary')?.setData(this.primaryData);
  }

  private source(id: string) {
    return this.map.getSource(id) as GeoJSONSource | undefined;
  }

  // ------------------------------------------------------------- map settings

  /** Swaps the basemap. Our pins are re-added on the new style's `style.load`. */
  setBasemap(s: MapStyle) {
    this.font = s.font ?? DEFAULT_FONT;
    this.recolour = s.recolour;
    this.overlay = s.overlay;
    this.noShading = !!s.noShading;
    this.map.setStyle(s.style, { diff: false });
  }

  /** Hill shading from free elevation tiles, drawn over land but under the sea, roads and labels. */
  setTerrain(on: boolean) {
    this.terrain = on;
    if (!this.map.getLayer('places')) return; // applied when the layers are (re)added
    if (on && !this.noShading) this.addTerrain();
    else {
      if (this.map.getLayer('terrain-shade')) this.map.removeLayer('terrain-shade');
      if (this.map.getSource('terrain-dem')) this.map.removeSource('terrain-dem');
    }
  }

  private addTerrain() {
    const m = this.map;
    if (m.getLayer('terrain-shade')) return;
    m.addSource('terrain-dem', {
      type: 'raster-dem',
      encoding: 'terrarium',
      tiles: [TERRAIN_TILES],
      tileSize: 256,
      maxzoom: 14,
      attribution: TERRAIN_ATTRIBUTION,
    });
    // After the area fills, before roads and labels. The elevation data includes the sea
    // floor, so the water fills are then moved back above the shading to hide it.
    const layers = m.getStyle().layers;
    const before = layers.find((l) => !['background', 'fill', 'raster'].includes(l.type))?.id;
    m.addLayer({
      id: 'terrain-shade',
      type: 'hillshade',
      source: 'terrain-dem',
      paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#473b24', 'hillshade-highlight-color': '#ffffff' },
    }, before);
    for (const l of layers) {
      const src = 'source-layer' in l ? l['source-layer'] ?? '' : '';
      if (l.type === 'fill' && (/^(water|ocean)/.test(l.id) || /^(water|ocean)/.test(src))) m.moveLayer(l.id, before);
    }
  }

  setProjection(p: Projection) {
    this.projection = p;
    if (this.map.isStyleLoaded()) this.map.setProjection({ type: p });
  }

  setPinColor(hex: string) {
    this.pin = hex;
    if (!this.map.getLayer('places')) return; // applied when the layers are (re)added
    for (const [layer, prop] of PIN_PAINT) this.map.setPaintProperty(layer, prop as 'circle-color', hex);
    this.map.setPaintProperty('primary', 'circle-color', primaryColor(hex));
  }

  /**
   * Loading view for an article. The first article starts from its own coordinate (or the
   * whole globe), slowly spinning until the pins are ready. Later articles leave the camera
   * where it is, so there's only one move: the flight to the new pins (see frameDensest).
   */
  placeCamera(primary: { lat: number; lon: number } | undefined) {
    this.interacted = false;
    if (this.framedOnce) {
      this.stopSpin();
      return;
    }
    if (primary) this.map.jumpTo({ center: [primary.lon, primary.lat], zoom: 2.2 });
    else this.map.jumpTo({ center: [20, 20], zoom: 1.4 });
    this.startSpin();
  }

  /** True once an article's pins have been framed; later articles glide from there. */
  private framedOnce = false;

  /** A slow, smooth camera move (zooming out and back in over long distances). */
  private glide(cam: { center: maplibregl.LngLatLike; zoom: number; bearing?: number; pitch?: number }) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.map.jumpTo(cam);
      return;
    }
    // MapLibre's default speed felt rushed now that articles load quickly. The duration grows
    // gently with distance: ~2 s next door, ~4 s across an ocean. (Not maxDuration: MapLibre
    // skips the animation entirely when a flight would exceed it.)
    const c = this.map.getCenter();
    const to = maplibregl.LngLat.convert(cam.center);
    const km = distanceKm({ lat: c.lat, lon: c.lng }, { lat: to.lat, lon: to.lng });
    const duration = Math.min(4500, 1600 + 1300 * Math.log10(1 + km / 100));
    this.map.flyTo({ ...cam, duration, curve: 1.35, essential: true });
  }

  /**
   * Final view once the pins are ranked: stops the spin and eases to the area with the most
   * (and most relevant) pins. Does nothing to the camera if the user has already moved it.
   */
  frameDensest(places: GlobePlace[], primary: { lat: number; lon: number } | undefined) {
    this.stopSpin();
    this.framedOnce = true;
    if (this.interacted) return;
    if (!places.length) {
      if (primary) this.glide({ center: [primary.lon, primary.lat], zoom: 3 });
      return;
    }
    const area = densestArea(places);
    // Include the article's own location when it's part of that area.
    if (primary && area.some((p) => distanceKm(p, primary) < 150)) area.push(primary as Place);
    if (area.length === 1) {
      this.glide({ center: [area[0].lon, area[0].lat], zoom: 5 });
      return;
    }
    this.fitTo(area, true);
  }

  private fitTo(places: Place[], animate = false) {
    const lats = places.map((p) => p.lat);
    // Choose whichever longitude frame (-180..180 or 0..360) gives the narrower box, so
    // pins either side of the antimeridian (e.g. NZ + Hawaii) don't produce a world-wide fit.
    const span = (lons: number[]) => Math.max(...lons) - Math.min(...lons);
    const a = places.map((p) => p.lon);
    const b = a.map((l) => (l < 0 ? l + 360 : l));
    const lons = span(b) < span(a) ? b : a;
    const w = Math.min(...lons), e = Math.max(...lons);
    const s = Math.min(...lats), n = Math.max(...lats);

    if (e - w > 200 || n - s > 120) {
      // Effectively global: show the hemisphere around the pins' centre.
      const mean = lons.reduce((x, y) => x + y, 0) / lons.length;
      const cam = { center: [((mean + 540) % 360) - 180, (n + s) / 2] as [number, number], zoom: 1.3 };
      if (animate) this.glide(cam);
      else this.map.jumpTo(cam);
      return;
    }
    const cam = this.map.cameraForBounds([[w, s], [e, n]], { padding: 60, maxZoom: 6 });
    if (cam && animate) this.glide({ center: cam.center!, zoom: cam.zoom!, bearing: cam.bearing });
    else if (cam) this.map.jumpTo(cam);
  }

  // ------------------------------------------------------------- highlight (driven by main.ts)

  /** Rings these places (whether or not they're pinned or inside a cluster). [] clears. */
  async highlight(places: Place[]) {
    await this.ready;
    this.highlightData = { type: 'FeatureCollection', features: places.map((p) => point(p)) };
    this.source('highlight')?.setData(this.highlightData);
  }

  /** Shows a place's card without pinning it (unless a card is pinned). null hides it. */
  preview(place: GlobePlace | null) {
    if (this.sticky) return;
    if (!place) {
      this.popup.remove();
      this.cardKey = null;
      return;
    }
    if (this.cardKey !== place.title) this.showCard(place, false);
  }

  /** Turns the globe so the place is comfortably in view (no-op if it already is). */
  turnTo(place: Place) {
    this.stopSpin();
    const m = this.map;
    const c = m.getCenter();
    const ang = greatCircleDeg(c.lat, c.lng, place.lat, place.lon);
    const pt = m.project([place.lon, place.lat]);
    const { clientWidth: w, clientHeight: h } = m.getContainer();
    const inView = ang < 70 && pt.x > w * 0.15 && pt.x < w * 0.85 && pt.y > h * 0.15 && pt.y < h * 0.85;
    if (inView) return;
    m.easeTo({
      center: [place.lon, place.lat],
      zoom: ang > 25 ? Math.min(m.getZoom(), 3) : m.getZoom(),
      duration: 700,
    });
  }

  /** Flies to a pinned place and pins its card. */
  select(title: string) {
    const p = this.byTitle.get(title);
    if (!p) return;
    this.interacted = true;
    this.stopSpin();
    this.sticky = true;
    this.showCard(p, true);
    this.map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(this.map.getZoom(), 4), speed: 1.2 });
    this.opts.onSelect?.(p.title);
  }

  // ------------------------------------------------------------- pointer on the globe

  private hoverPin(f: MapGeoJSONFeature | undefined) {
    const title = f?.properties?.title as string | undefined;
    if (!title) return;
    this.pointerOn(title, () => {
      const p = this.byTitle.get(title);
      if (p) this.preview(p);
      this.opts.onHover?.([title]);
    });
  }

  private hoverCluster(f: MapGeoJSONFeature | undefined) {
    const id = f?.properties?.cluster_id as number | undefined;
    if (id === undefined) return;
    this.pointerOn(`cluster:${id}`, async () => {
      const leaves = (await this.source('places')!.getClusterLeaves(id, 500, 0)) as GeoJSON.Feature[];
      if (this.hoverKey !== `cluster:${id}`) return;
      const places = leaves
        .map((l) => this.byTitle.get(l.properties!.title as string))
        .filter((p): p is GlobePlace => !!p)
        .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
      if (!this.sticky) this.showClusterCard(id, f!.geometry as GeoJSON.Point, places);
      this.opts.onHover?.(places.map((p) => p.title));
    });
  }

  private pointerOn(key: string, enter: () => void) {
    this.interacted = true;
    this.stopSpin();
    this.map.getCanvas().style.cursor = 'pointer';
    if (this.hoverKey === key) return;
    this.hoverKey = key;
    enter();
  }

  private leave() {
    this.map.getCanvas().style.cursor = '';
    this.hoverKey = null;
    this.preview(null);
    this.opts.onHover?.([]);
  }

  private async zoomIntoCluster(f: MapGeoJSONFeature | undefined) {
    const id = f?.properties?.cluster_id as number | undefined;
    if (id === undefined) return;
    const zoom = await this.source('places')!.getClusterExpansionZoom(id);
    const [lon, lat] = (f!.geometry as GeoJSON.Point).coordinates;
    this.map.easeTo({ center: [lon, lat], zoom: zoom + 0.3, duration: 600 });
  }

  /** Closes the pinned card (e.g. on Escape). */
  deselect() {
    this.unpin();
  }

  private unpin() {
    if (!this.sticky) return;
    this.sticky = false;
    this.popup.remove();
    this.cardKey = null;
  }

  // ------------------------------------------------------------- cards

  private showCard(p: GlobePlace, sticky: boolean) {
    this.cardKey = p.title;
    const card = el('article', 'card');
    const h = el('h3', '', displayTitle(p.title));
    // Keep the qualifier ("Ottoman Empire" in "Fifth Army (Ottoman Empire)"), just quieter.
    const qual = p.title.match(/\(([^)]*)\)$/)?.[1];
    if (qual) h.append(' ', el('span', 'qual', qual));
    const desc = el('p', 'card-desc');
    const extract = el('div', 'card-extract');
    extract.append(el('p', 'card-loading', 'Loading…'));
    card.append(h, desc);
    // How the article uses this place: known locally, so it shows immediately.
    if (p.snippet) card.append(el('p', 'card-snippet', p.snippet));
    card.append(extract);
    if (sticky) card.append(this.cardActions(p.title));
    else if (this.byTitle.has(p.title)) card.append(el('p', 'card-hint', 'Click the pin to jump to it in the article'));
    this.popup.setLngLat([p.lon, p.lat]).setDOMContent(card).addTo(this.map);

    const current = () => this.cardKey === p.title;
    const reanchor = () => { if (current()) this.popup.setLngLat([p.lon, p.lat]); };
    getSummary(p.title).then(
      (s) => {
        if (!current()) return; // moved on
        if (s.thumbnail) {
          const img = el('img', 'card-thumb');
          img.src = s.thumbnail.source;
          img.alt = '';
          img.width = Math.min(s.thumbnail.width, 96);
          img.addEventListener('load', reanchor, { once: true });
          card.prepend(img);
        }
        desc.textContent = s.description ?? '';
        extract.replaceChildren();
        if (s.extract) extract.append(el('p', '', truncate(s.extract, p.snippet ? 180 : 260)));
        // The card grew: re-run MapLibre's auto-anchoring so it isn't clipped at the edge.
        reanchor();
      },
      () => {
        if (current()) extract.replaceChildren(el('p', 'card-loading', 'No summary available.'));
      },
    );
  }

  private showClusterCard(id: number, at: GeoJSON.Point, places: GlobePlace[]) {
    this.cardKey = `cluster:${id}`;
    const card = el('article', 'card cluster-card');
    card.append(el('h3', '', `${places.length} places`));
    const ul = el('ul', 'cluster-list');
    for (const p of places.slice(0, 7)) ul.append(el('li', '', displayTitle(p.title)));
    card.append(ul);
    const more = places.length > 7 ? `+${places.length - 7} more · ` : '';
    card.append(el('p', 'card-hint', `${more}Click to zoom in`));
    this.popup.setLngLat(at.coordinates as [number, number]).setDOMContent(card).addTo(this.map);
  }

  private cardActions(title: string) {
    const row = el('div', 'card-actions');
    const open = el('button', '', 'Map this article');
    open.type = 'button';
    open.addEventListener('click', () => this.opts.onOpen(title));
    const wp = el('a', '', 'Wikipedia ↗');
    wp.href = wikipediaUrl(title);
    wp.target = '_blank';
    wp.rel = 'noopener';
    row.append(open, wp);
    return row;
  }

  // ------------------------------------------------------------- idle spin

  startSpin() {
    if (this.spinning || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    this.spinning = true;
    this.lastFrame = performance.now();
    const step = (now: number) => {
      if (!this.spinning) return;
      const dt = Math.min(now - this.lastFrame, 100) / 1000;
      this.lastFrame = now;
      // Constant on-screen speed: slower the further in we are; no spin when zoomed right in.
      const z = this.map.getZoom();
      if (z < 4.5) {
        const c = this.map.getCenter();
        this.map.setCenter([c.lng - SPIN_DEG_PER_SEC * dt * Math.pow(2, 1.5 - Math.max(z, 1.5)), c.lat]);
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  stopSpin() {
    this.spinning = false;
  }
}

/** Radius (km) of the "neighbourhood" used to find where pins are most concentrated. */
const CLUSTER_KM = 600;
/** Candidate radii (km) for the framed area, tightest first. */
const AREA_RADII_KM = [150, 400, 800, 1600];

function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The pins around the most concentrated spot. Each pin is scored by its neighbours (weighted
 * by relevance, fading with distance) to find the centre; the area is then the smallest
 * circle around it holding at least half of all the pins' relevance.
 */
function densestArea(places: GlobePlace[]): Place[] {
  const value = (p: GlobePlace) => 0.3 + (p.weight ?? 0.5);
  let best = places[0], bestScore = -1;
  for (const p of places) {
    let score = 0;
    for (const q of places) score += value(q) * Math.exp(-((distanceKm(p, q) / CLUSTER_KM) ** 2));
    if (score > bestScore) [best, bestScore] = [p, score];
  }
  const total = places.reduce((t, p) => t + value(p), 0);
  for (const km of AREA_RADII_KM) {
    const area = places.filter((q) => distanceKm(best, q) <= km);
    if (area.reduce((t, p) => t + value(p), 0) >= total * 0.5) return area;
  }
  return places.filter((q) => distanceKm(best, q) <= AREA_RADII_KM.at(-1)!);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** "Fifth Army (Ottoman Empire)" -> "Fifth Army"; the qualifier only disambiguates titles. */
export function displayTitle(title: string): string {
  return title.replace(/\s*\([^)]*\)$/, '') || title;
}

function truncate(s: string, n: number) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return cut.slice(0, cut.lastIndexOf(' ')) + '…';
}

function greatCircleDeg(lat1: number, lon1: number, lat2: number, lon2: number) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(a)))) / r;
}
