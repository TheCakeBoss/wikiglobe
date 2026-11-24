import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre finds its worker next to its own module, which breaks once Vite pre-bundles it.
// The worker file is self-contained, so hand Vite the URL directly (works in dev and build).
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { MAP_ATTRIBUTION, MAP_STYLE_URL } from './config';
import { getSummary, wikipediaUrl, type Place } from './wiki';

export interface GlobeOptions {
  /** Called when the user chooses to open a place's article inside the app. */
  onOpen: (title: string) => void;
}

maplibregl.setWorkerUrl(workerUrl);

/** Degrees of longitude per second at whole-globe zoom. */
const SPIN_DEG_PER_SEC = 4;
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export class Globe {
  private map: maplibregl.Map;
  private ready: Promise<void>;
  private places: Place[] = [];
  private hoverId: number | null = null;
  private popup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    maxWidth: '320px',
    offset: 10,
    className: 'place-popup',
  });
  private stickyId: number | null = null;
  private spinning = false;
  /** Set once the user drags, zooms or clicks the globe; cleared by placeCamera(). */
  private interacted = false;
  private lastFrame = 0;

  constructor(container: HTMLElement, private opts: GlobeOptions) {
    this.map = new maplibregl.Map({
      container,
      style: MAP_STYLE_URL,
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
    this.ready = new Promise((resolve) => this.map.once('style.load', () => {
      this.map.setProjection({ type: 'globe' });
      this.addLayers();
      resolve();
    }));

    // Any direct interaction stops the idle spin.
    for (const ev of ['pointerdown', 'wheel', 'touchstart', 'keydown']) {
      container.addEventListener(ev, () => {
        this.interacted = true;
        this.stopSpin();
      }, { passive: true, capture: true });
    }
  }

  private addLayers() {
    const m = this.map;
    m.addSource('places', { type: 'geojson', data: EMPTY });
    m.addSource('primary', { type: 'geojson', data: EMPTY });

    m.addLayer({
      id: 'places',
      type: 'circle',
      source: 'places',
      paint: {
        'circle-radius': [
          'interpolate', ['linear'], ['zoom'],
          1, ['case', ['boolean', ['feature-state', 'hover'], false], 7, 4.5],
          8, ['case', ['boolean', ['feature-state', 'hover'], false], 11, 7],
        ],
        'circle-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#ff6a3d', '#d9381e'],
        'circle-opacity': 0.9,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2.5, 1.25],
      },
    });
    m.addLayer({
      id: 'primary',
      type: 'circle',
      source: 'primary',
      paint: {
        'circle-radius': 8,
        'circle-color': '#1f5fbf',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 3,
      },
    });

    m.on('mousemove', 'places', (e) => {
      const f = e.features?.[0];
      if (f) this.hover(f);
    });
    m.on('mouseleave', 'places', () => this.unhover());
    m.on('click', 'places', (e) => {
      const f = e.features?.[0];
      if (f) this.select(f);
    });
    m.on('click', (e) => {
      // Click on empty globe clears the sticky card.
      if (!m.queryRenderedFeatures(e.point, { layers: ['places'] }).length) this.clearSticky();
    });
  }

  /** Replace the pins without moving the camera. */
  async setPlaces(places: Place[], primary: { lat: number; lon: number } | undefined) {
    await this.ready;
    this.clearSticky();
    this.unhover();
    this.places = places;
    (this.map.getSource('places') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: places.map((p, i) => ({
        type: 'Feature',
        id: i,
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { title: p.title },
      })),
    });
    (this.map.getSource('primary') as GeoJSONSource).setData(
      primary
        ? { type: 'Feature', geometry: { type: 'Point', coordinates: [primary.lon, primary.lat] }, properties: {} }
        : EMPTY,
    );
  }

  /**
   * Opening view for an article: its own coordinate if it has one, else a fit to the pins.
   * Restarts the idle spin. With `onlyIfIdle`, does nothing once the user has touched the globe.
   */
  placeCamera(places: Place[], primary: { lat: number; lon: number } | undefined, onlyIfIdle = false) {
    if (onlyIfIdle && this.interacted) return;
    this.interacted = false;
    if (primary) {
      this.map.jumpTo({ center: [primary.lon, primary.lat], zoom: 2.2 });
    } else if (places.length) {
      this.fitTo(places);
    } else {
      this.map.jumpTo({ center: [20, 20], zoom: 1.4 });
    }
    this.startSpin();
  }

  private fitTo(places: Place[]) {
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
      this.map.jumpTo({ center: [((mean + 540) % 360) - 180, (n + s) / 2], zoom: 1.3 });
      return;
    }
    const cam = this.map.cameraForBounds([[w, s], [e, n]], { padding: 60, maxZoom: 5 });
    if (cam) this.map.jumpTo(cam);
  }

  // ------------------------------------------------------------- hover cards

  private setHover(id: number | null) {
    if (this.hoverId !== null) this.map.setFeatureState({ source: 'places', id: this.hoverId }, { hover: false });
    this.hoverId = id;
    if (id !== null) this.map.setFeatureState({ source: 'places', id }, { hover: true });
  }

  private hover(f: MapGeoJSONFeature) {
    this.interacted = true;
    this.stopSpin();
    this.map.getCanvas().style.cursor = 'pointer';
    const id = f.id as number;
    if (this.stickyId !== null && this.stickyId !== id) return; // a pinned card stays put
    if (id === this.hoverId) return;
    this.setHover(id);
    this.showCard(id, false);
  }

  private unhover() {
    this.map.getCanvas().style.cursor = '';
    if (this.stickyId !== null) return;
    this.setHover(null);
    this.popup.remove();
  }

  private select(f: MapGeoJSONFeature) {
    const id = f.id as number;
    const p = this.places[id];
    this.stickyId = id;
    this.setHover(id);
    this.showCard(id, true);
    this.map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(this.map.getZoom(), 4), speed: 1.2 });
  }

  private clearSticky() {
    if (this.stickyId === null) return;
    this.stickyId = null;
    this.setHover(null);
    this.popup.remove();
  }

  private showCard(id: number, sticky: boolean) {
    const p = this.places[id];
    const card = document.createElement('article');
    card.className = 'card';
    const h = document.createElement('h3');
    h.textContent = p.title;
    const body = document.createElement('div');
    body.className = 'card-body';
    body.innerHTML = '<p class="card-loading">Loading…</p>';
    card.append(h, body);
    if (sticky) card.append(this.cardActions(p.title));
    this.popup.setLngLat([p.lon, p.lat]).setDOMContent(card).addTo(this.map);

    getSummary(p.title).then(
      (s) => {
        if (this.hoverId !== id) return; // moved on
        body.replaceChildren();
        if (s.thumbnail) {
          const img = document.createElement('img');
          img.src = s.thumbnail.source;
          img.alt = '';
          img.className = 'card-thumb';
          img.width = Math.min(s.thumbnail.width, 96);
          card.insertBefore(img, h);
        }
        if (s.description) {
          const d = document.createElement('p');
          d.className = 'card-desc';
          d.textContent = s.description;
          body.append(d);
        }
        if (s.extract) {
          const x = document.createElement('p');
          x.className = 'card-extract';
          x.textContent = truncate(s.extract, 260);
          body.append(x);
        }
        if (!sticky) {
          const hint = document.createElement('p');
          hint.className = 'card-hint';
          hint.textContent = 'Click the pin for links';
          body.append(hint);
        }
        // The card grew: re-run MapLibre's auto-anchoring so it isn't clipped at the edge.
        const reanchor = () => { if (this.hoverId === id) this.popup.setLngLat([p.lon, p.lat]); };
        reanchor();
        card.querySelector('img')?.addEventListener('load', reanchor, { once: true });
      },
      () => {
        if (this.hoverId === id) body.innerHTML = '<p class="card-loading">No summary available.</p>';
      },
    );
  }

  private cardActions(title: string) {
    const row = document.createElement('div');
    row.className = 'card-actions';
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = 'Map this article';
    open.addEventListener('click', () => this.opts.onOpen(title));
    const wp = document.createElement('a');
    wp.href = wikipediaUrl(title);
    wp.target = '_blank';
    wp.rel = 'noopener';
    wp.textContent = 'Wikipedia ↗';
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

  resize() {
    this.map.resize();
  }
}

function truncate(s: string, n: number) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return cut.slice(0, cut.lastIndexOf(' ')) + '…';
}
