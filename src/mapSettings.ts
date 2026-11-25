import { DEFAULT_MAP_STYLE, MAP_STYLES, PIN_COLORS } from './config';
import type { Globe, Projection } from './globe';

/**
 * Map view settings (globe or flat, basemap style, pin colour) and the picker that
 * changes them. Remembered per browser.
 */
export interface MapSettings {
  projection: Projection;
  style: string; // MapStyle id
  pin: string; // PIN_COLORS id
  terrain: boolean;
}

const KEY = 'wg:map';

export function loadMapSettings(): MapSettings {
  let saved: Partial<MapSettings> = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { /* ignore */ }
  if (saved.style === 'dark') saved.style = 'graphite'; // Dark was replaced by Graphite
  return {
    projection: saved.projection === 'mercator' ? 'mercator' : 'globe',
    style: MAP_STYLES.some((s) => s.id === saved.style) ? saved.style! : DEFAULT_MAP_STYLE,
    pin: PIN_COLORS.some((c) => c.id === saved.pin) ? saved.pin! : PIN_COLORS[0].id,
    terrain: saved.terrain === true,
  };
}

export const mapStyle = (id: string) => MAP_STYLES.find((s) => s.id === id) ?? MAP_STYLES[0];
export const pinHex = (id: string) => (PIN_COLORS.find((c) => c.id === id) ?? PIN_COLORS[0]).hex;

/** Article highlights, the list and the timeline use the pin colour too. */
export function applyPinCss(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const root = document.documentElement.style;
  root.setProperty('--pin', hex);
  root.setProperty('--pin-rgb', `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`);
}

export function initMapSettings(host: HTMLElement, getGlobe: () => Globe | undefined, settings: MapSettings) {
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* ignore */ } };

  const wrap = document.createElement('div');
  wrap.className = 'map-settings';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'map-settings-btn';
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-haspopup', 'true');
  button.innerHTML = '<span aria-hidden="true">◐</span> Map';
  const panel = document.createElement('div');
  panel.className = 'map-settings-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Map settings');
  // Opens the globe's current view in Google Maps (its zoom levels are one higher).
  const gmaps = document.createElement('a');
  gmaps.className = 'map-settings-btn gmaps-btn';
  gmaps.target = '_blank';
  gmaps.rel = 'noopener';
  gmaps.title = 'Open this view in Google Maps';
  gmaps.innerHTML = '<svg class="icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 14.5s4.8-4.6 4.8-8.1a4.8 4.8 0 0 0-9.6 0c0 3.5 4.8 8.1 4.8 8.1z"/><circle cx="8" cy="6.4" r="1.7"/></svg>Google Maps';
  const setHref = () => {
    const v = getGlobe()?.view();
    gmaps.href = v
      ? `https://www.google.com/maps/@${v.lat.toFixed(5)},${v.lon.toFixed(5)},${Math.min(21, Math.max(2, v.zoom + 1)).toFixed(1)}z`
      : 'https://www.google.com/maps';
  };
  // Refresh just before it's followed (click, middle-click, keyboard, context menu).
  for (const ev of ['pointerdown', 'focus', 'mouseenter']) gmaps.addEventListener(ev, setHref);
  gmaps.addEventListener('click', setHref);
  setHref();
  wrap.append(button, gmaps, panel);
  host.append(wrap);

  // Hover preview: a small picture of each style (public/map-previews, all the same
  // view of the Alps), so a style can be judged before the whole map reloads.
  const preview = document.createElement('figure');
  preview.className = 'map-preview';
  preview.hidden = true;
  const previewImg = document.createElement('img');
  previewImg.alt = '';
  previewImg.width = 240;
  previewImg.height = 150;
  const previewCap = document.createElement('figcaption');
  preview.append(previewImg, previewCap);
  wrap.append(preview);
  const previewSrc = (id: string) => `${import.meta.env.BASE_URL}map-previews/${id}.webp`;
  let preloaded = false;
  const preload = () => {
    if (preloaded) return;
    preloaded = true;
    for (const id of [...MAP_STYLES.map((s) => s.id), 'terrain']) new Image().src = previewSrc(id);
  };
  const showPreview = (b: HTMLElement, id: string, label: string, note?: string) => {
    previewImg.src = previewSrc(id);
    previewCap.replaceChildren(Object.assign(document.createElement('strong'), { textContent: label }));
    if (note) previewCap.append(document.createElement('br'), note);
    preview.hidden = false;
    // Beside the panel when there's room, otherwise over the map below the button.
    const room = host.clientWidth - wrap.offsetLeft - panel.offsetLeft - panel.offsetWidth - 16;
    const top = panel.offsetTop + b.offsetTop;
    if (room >= preview.offsetWidth) {
      preview.style.left = `${panel.offsetLeft + panel.offsetWidth + 8}px`;
      preview.style.top = `${Math.max(0, Math.min(top - 40, host.clientHeight - wrap.offsetTop - preview.offsetHeight - 8))}px`;
    } else {
      preview.style.left = `${panel.offsetLeft + b.offsetLeft}px`;
      preview.style.top = `${top + b.offsetHeight + 6}px`;
    }
  };
  const hidePreview = () => { preview.hidden = true; };
  const withPreview = (b: HTMLElement, id: string, label: string, note?: string) => {
    const show = () => showPreview(b, id, label, note);
    b.addEventListener('mouseenter', show);
    b.addEventListener('focus', show);
    b.addEventListener('mouseleave', hidePreview);
    b.addEventListener('blur', hidePreview);
  };

  const group = (label: string) => {
    const g = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = label;
    g.append(legend);
    panel.append(g);
    return g;
  };
  const option = (g: HTMLElement, cls: string, label: string, pressed: () => boolean, onPick: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.title = label;
    b.addEventListener('click', () => {
      onPick();
      save();
      refresh();
    });
    g.append(b);
    refreshers.push(() => b.setAttribute('aria-pressed', String(pressed())));
    return b;
  };
  const refreshers: (() => void)[] = [];
  const refresh = () => refreshers.forEach((r) => r());

  const view = group('View');
  for (const [id, label] of [['globe', 'Globe'], ['mercator', 'Flat']] as const) {
    option(view, 'seg', label, () => settings.projection === id, () => {
      settings.projection = id;
      getGlobe()?.setProjection(id);
    }).textContent = label;
  }

  const styles = group('Style');
  for (const s of MAP_STYLES) {
    const b = option(styles, 'style-opt', s.label, () => settings.style === s.id, () => {
      if (settings.style === s.id) return;
      settings.style = s.id;
      getGlobe()?.setBasemap(s);
    });
    const sw = document.createElement('span');
    sw.className = 'style-swatch';
    sw.style.background = `linear-gradient(135deg, ${s.swatch[0]} 50%, ${s.swatch[1]} 50%)`;
    b.append(sw, document.createTextNode(s.label));
    withPreview(b, s.id, s.label, s.note);
  }

  const terrain = group('Terrain');
  const shading = option(terrain, 'seg', 'Hill shading', () => settings.terrain, () => {
    settings.terrain = !settings.terrain;
    getGlobe()?.setTerrain(settings.terrain);
  });
  shading.textContent = 'Hill shading';
  withPreview(shading, 'terrain', 'Hill shading', 'Shades hills and mountains. Not used on the NASA imagery styles.');
  refreshers.push(() => {
    const off = !!mapStyle(settings.style).noShading;
    shading.disabled = off;
    shading.title = off ? 'Hill shading isn’t used on NASA imagery' : 'Hill shading';
  });

  const pins = group('Pin colour');
  for (const c of PIN_COLORS) {
    const b = option(pins, 'pin-opt', c.label, () => settings.pin === c.id, () => {
      settings.pin = c.id;
      applyPinCss(c.hex);
      getGlobe()?.setPinColor(c.hex);
    });
    b.style.setProperty('--c', c.hex);
    b.setAttribute('aria-label', c.label);
  }
  refresh();

  const open = (yes: boolean | string) => {
    yes = !!yes;
    panel.hidden = !yes;
    if (yes) preload();
    else hidePreview();
    button.setAttribute('aria-expanded', String(yes));
  };
  button.addEventListener('click', () => open(panel.hidden));
  document.addEventListener('pointerdown', (e) => { if (!wrap.contains(e.target as Node)) open(false); });
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      open(false);
      button.focus();
      e.stopPropagation();
    }
  });
}
