import './style.css';
import { displayTitle, Globe, type GlobePlace } from './globe';
import { attachSearch } from './search';
import { filterPlaces } from './filter';
import { loadArticleHtml } from './article';
import { ArticleIndex, type ScoredPlace } from './relevance';
import { sameSentence } from './sentence';
import { indexYears, Timeline, topYears, type YearInfo } from './timeline';
import { initLayout } from './layout';
import { PageHistory } from './history';
import { initPrefetch } from './prefetch';
import { applyPinCss, initMapSettings, loadMapSettings, mapStyle, pinHex } from './mapSettings';
import {
  getSummary, loadArticle, NotFoundError, parseTitleInput, toPageParam, wikipediaUrl, type ArticleData,
} from './wiki';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const landing = $('landing');
const viewer = $('viewer');
const pane = document.querySelector<HTMLElement>('.article-pane')!;
const topSearch = document.querySelector<HTMLFormElement>('.search-top')!;
const topSearchInput = $<HTMLInputElement>('search-top');
const titleEl = $('article-title');
const descEl = $('article-desc');
const bodyEl = $('article-body');
const statusEl = $('globe-status');
const listEl = $('place-list');
const chip = $<HTMLButtonElement>('mention-chip');
const posBadge = $('mention-pos');
const topN = $<HTMLInputElement>('top-n');
const topNOut = $<HTMLOutputElement>('top-n-out');
const sourceLink = $('source-link');

const DEFAULT_TOP_N = 40;

/** Everything known about the article on screen. */
interface View {
  data?: ArticleData;
  /** Built once the article HTML is rendered. */
  index?: ArticleIndex;
  /** The HTML failed to load: fall back to unscored pins. */
  htmlFailed?: boolean;
  /** Every ranked place (pinned or not), by title. */
  ranked: Map<string, ScoredPlace>;
  /** Places pinned right now, by title. */
  shown: Map<string, GlobePlace>;
  /** Years mentioned in the article. */
  years: Map<number, YearInfo>;
}

const emptyView = (): View => ({ ranked: new Map(), shown: new Map(), years: new Map() });

let globe: Globe | undefined;
let view: View = emptyView();
let loadCtrl: AbortController | undefined;

const timeline = new Timeline($('timeline'), {
  onHover: (year) => setFocus('timeline', year === null ? null : { kind: 'year', year }),
  onSelect: (year) => {
    const spans = view.years.get(year)?.spans ?? [];
    timeline.setSelected(year);
    selectMentions(`year:${year}`, spans);
  },
});

initLayout(() => positionChip());
const pageHistory = new PageHistory();
initPrefetch();

const mapSettings = loadMapSettings();
applyPinCss(pinHex(mapSettings.pin));
initMapSettings(document.querySelector('.globe-wrap')!, () => globe, mapSettings);

// ------------------------------------------------------------------ routing

function pageFromUrl(): string | null {
  const p = new URLSearchParams(location.search).get('page');
  return p ? parseTitleInput(p) : null;
}

/** `?page=Title` plus non-default view options, so a shared link opens the same view. */
function urlFor(title: string, keepHash = false) {
  const q = new URLSearchParams();
  q.set('page', toPageParam(title));
  if (Number(topN.value) !== DEFAULT_TOP_N) q.set('n', topN.value);
  return `?${q.toString().replace(/%2F/g, '/')}${keepHash ? location.hash : ''}`;
}

function readViewOptions() {
  const q = new URLSearchParams(location.search);
  const n = Number(q.get('n'));
  topN.value = String(n >= 10 && n <= 200 ? n : DEFAULT_TOP_N);
  topNOut.value = topN.value;
}

function navigate(title: string) {
  history.pushState(null, '', `?page=${encodeURIComponent(toPageParam(title))}`);
  route();
}

function route() {
  readViewOptions();
  const page = pageFromUrl();
  // Back/forward between footnote jumps on the same article: just scroll.
  if (page && view.index && view.data && toPageParam(page) === toPageParam(view.data.title)) {
    if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
    else pane.scrollTop = 0;
    renderPlaces(false); // view options may differ between entries
    return;
  }
  if (page) showArticle(page);
  else showLanding();
}

window.addEventListener('popstate', route);

document.addEventListener('click', (e) => {
  const a = (e.target as Element).closest('a');
  if (!a || a.target === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname !== location.pathname) return;
  // In-page anchors (footnotes, section links) scroll normally.
  if (url.search === location.search && url.hash) return;
  // Same-origin ?page= links (article links, examples, brand) are handled in-app.
  e.preventDefault();
  history.pushState(null, '', url.search + url.hash || location.pathname);
  route();
});

// ------------------------------------------------------------------ views

function showLanding() {
  loadCtrl?.abort();
  document.title = 'Wikipedia Globe';
  landing.hidden = false;
  viewer.hidden = true;
  topSearch.hidden = true;
  sourceLink.textContent = '';
  $<HTMLInputElement>('search-hero').focus();
}

function setStatus(msg: string | null, kind: 'loading' | 'empty' | 'error' = 'loading') {
  statusEl.hidden = !msg;
  statusEl.className = `globe-status ${kind}`;
  statusEl.textContent = msg ?? '';
}

async function showArticle(input: string) {
  landing.hidden = true;
  viewer.hidden = false;
  topSearch.hidden = false;
  topSearchInput.value = input;
  globe ??= new Globe($('globe'), {
    style: mapStyle(mapSettings.style),
    terrain: mapSettings.terrain,
    projection: mapSettings.projection,
    pinColor: pinHex(mapSettings.pin),
    onOpen: navigate,
    onSelect: (title) => selectPlace(title),
    onHover: (titles) => setFocus('globe', titles.length ? { kind: 'places', titles } : null),
    onDeselect: () => clearSelection(),
  });

  loadCtrl?.abort();
  const ctrl = (loadCtrl = new AbortController());
  const v: View = (view = emptyView());
  marked.clear();
  performance.mark('wg:article-start', { detail: input });
  setFocus('globe', null);
  clearSelection();
  titleEl.textContent = input;
  descEl.textContent = '';
  bodyEl.replaceChildren();
  bodyEl.classList.add('loading');
  listEl.replaceChildren();
  timeline.render([]);
  pane.scrollTop = 0;
  setStatus('Finding places…');
  document.title = `${input} · Wikipedia Globe`;

  globe.placeCamera(undefined);
  let cameraPlaced = false;
  let titleShown = false;
  const live = () => !ctrl.signal.aborted && view === v;

  // Article HTML and place coordinates load in parallel.
  const htmlP = loadArticleHtml(input).then(
    (html) => {
      if (!live()) return;
      renderArticle(html);
      v.years = indexYears(bodyEl);
      timeline.render(topYears(v.years));
      v.index = new ArticleIndex(bodyEl);
      if (v.data) renderPlaces(true);
    },
    (err) => {
      if (!live() || err instanceof NotFoundError) return;
      console.warn('article HTML failed', err);
      v.htmlFailed = true;
      bodyEl.classList.remove('loading');
      bodyEl.innerHTML = '<p class="article-error">Couldn’t load the article text. Pins are shown unranked.</p>';
      if (v.data) renderPlaces(true);
    },
  );

  try {
    const data = await loadArticle(input, ctrl.signal, (p) => {
      // Progressive: pins update as each batch of links arrives.
      if (!live()) return;
      v.data = p;
      if (!titleShown) {
        titleShown = true;
        showTitle(p.title, ctrl.signal);
      }
      if (!cameraPlaced && p.primary) {
        globe!.placeCamera(p.primary);
        cameraPlaced = true;
      }
      renderPlaces(true);
    });
    if (!live()) return;
    v.data = data;
    if (!titleShown) showTitle(data.title, ctrl.signal);
    await htmlP; // ranking needs the article
    if (!live()) return;
    const shown = renderPlaces(false);
    // Stop spinning and show where the pins are concentrated (unless the user took over).
    globe.frameDensest(shown, data.primary);
  } catch (err) {
    if (!live()) return;
    console.error(err);
    await globe.setPlaces([], undefined);
    bodyEl.classList.remove('loading');
    if (err instanceof NotFoundError) {
      titleEl.textContent = input;
      setStatus(`There's no English Wikipedia article called “${input}”.`, 'error');
    } else {
      setStatus('Couldn’t reach Wikipedia. Check your connection and try again.', 'error');
    }
  }
}

function showTitle(title: string, signal: AbortSignal) {
  if (title !== pageFromUrl()) history.replaceState(null, '', urlFor(title, true));
  titleEl.textContent = title;
  topSearchInput.value = title;
  document.title = `${title} · Wikipedia Globe`;
  pageHistory.visit(title);
  setSourceLink(title);
  getSummary(title).then(
    (s) => { if (!signal.aborted) descEl.textContent = s.description ?? ''; },
    () => {},
  );
}

/**
 * Load milestones as performance marks (`wg:article-start`, `wg:first-pins`, `wg:text`,
 * `wg:ranked`), once each per article, for measuring load times in DevTools.
 */
const marked = new Set<string>();
function mark(name: string) {
  if (marked.has(name)) return;
  marked.add(name);
  performance.mark(`wg:${name}`, { detail: view.data?.title });
}

function renderArticle(html: string) {
  bodyEl.classList.remove('loading');
  bodyEl.innerHTML = html; // sanitised by DOMPurify in loadArticleHtml
  mark('text');
  if (location.hash) {
    document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
  }
}

/**
 * Ranks places and updates pins, list and count. `loading`: more batches may arrive.
 * Returns the places now pinned.
 */
function renderPlaces(loading: boolean): GlobePlace[] {
  const v = view;
  const data = v.data;
  if (!data || !globe) return [];

  // Countries and other large regions are left out, unless they're all the article has.
  const small = filterPlaces(data.places, false);
  const candidates = small.length ? small : data.places;
  const n = Number(topN.value);

  // Article text not here yet, so nothing can be ranked: show every place found so far as
  // small, faint pins so the globe fills in straight away. They're replaced once it's ranked.
  if (!v.index && !v.htmlFailed) {
    const prelim = candidates.map((p) => ({ ...p, weight: 0.1 }));
    globe.setPlaces(prelim, data.primary);
    renderList([], 'Ranking places…');
    if (prelim.length || data.primary) setStatus(null);
    if (prelim.length) mark('first-pins');
    return prelim;
  }

  let pins: GlobePlace[];
  let total: number;
  if (v.index) {
    const { ranked } = v.index.score(candidates);
    v.ranked = new Map(ranked.map((p) => [p.title, p]));
    total = ranked.length;
    pins = withWeights(ranked.slice(0, n));
  } else {
    total = candidates.length;
    pins = candidates.slice(0, n);
  }
  v.shown = new Map(pins.map((p) => [p.title, p]));

  topN.disabled = total <= 10;

  globe.setPlaces(pins, data.primary);
  renderList(pins);
  if (pins.length) mark('first-pins');
  if (!loading) mark('ranked');

  if (pins.length || data.primary) {
    setStatus(null);
  } else if (!loading) {
    setStatus('No mapped locations. None of the places this article mentions have coordinates on Wikipedia.', 'empty');
  }
  return pins;
}

/** Map scores to 0..1 pin weights (square-root, so mid-ranked places stay visible). */
function withWeights(places: ScoredPlace[]): GlobePlace[] {
  const max = places[0]?.score ?? 1;
  const min = places[places.length - 1]?.score ?? 0;
  return places.map((p) => ({ ...p, weight: max > min ? Math.sqrt((p.score - min) / (max - min)) : 1 }));
}

// ------------------------------------------------------------------ place list

function renderList(pins: GlobePlace[], emptyText?: string) {
  if (!pins.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = emptyText ?? (view.data ? 'No mapped places.' : 'Loading…');
    listEl.replaceChildren(li);
    return;
  }
  const max = (pins[0] as ScoredPlace).score ?? 1;
  listEl.replaceChildren(...pins.map((p) => {
    const s = p as Partial<ScoredPlace>;
    const li = document.createElement('li');
    li.dataset.title = p.title;
    li.tabIndex = 0;
    const name = document.createElement('span');
    name.className = 'place-name';
    name.textContent = displayTitle(p.title);
    name.title = p.title;
    const meta = document.createElement('span');
    meta.className = 'place-meta';
    const bar = document.createElement('span');
    bar.className = 'place-bar';
    const fill = document.createElement('span');
    fill.style.width = `${Math.max(6, ((s.score ?? max) / max) * 100)}%`;
    bar.append(fill);
    const what = [s.links ? `${s.links} link${s.links === 1 ? '' : 's'}` : '', s.mentions ? `${s.mentions}×` : '']
      .filter(Boolean).join(' · ');
    meta.append(bar, document.createTextNode(what));
    li.append(name, meta);
    if (selection?.key === `place:${p.title}`) li.classList.add('sel');
    return li;
  }));
}

// A short delay before the globe follows the pointer, so sweeping over rows while
// scrolling the list doesn't swing the globe from place to place.
const LIST_HOVER_MS = 120;
let listHoverTimer = 0;
listEl.addEventListener('mouseover', (e) => {
  const li = (e.target as Element).closest<HTMLElement>('li[data-title]');
  if (!li) return;
  clearTimeout(listHoverTimer);
  listHoverTimer = window.setTimeout(() => setFocus('list', { kind: 'places', titles: [li.dataset.title!] }), LIST_HOVER_MS);
});
listEl.addEventListener('mouseleave', () => {
  clearTimeout(listHoverTimer);
  setFocus('list', null);
});
listEl.addEventListener('click', (e) => {
  const li = (e.target as Element).closest<HTMLElement>('li[data-title]');
  if (li) globe?.select(li.dataset.title!);
});
listEl.addEventListener('keydown', (e) => {
  const li = (e.target as Element).closest<HTMLElement>('li[data-title]');
  if (!li) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    globe?.select(li.dataset.title!);
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    ((e.key === 'ArrowDown' ? li.nextElementSibling : li.previousElementSibling) as HTMLElement | null)?.focus();
  }
});
listEl.addEventListener('focusin', (e) => {
  const li = (e.target as Element).closest<HTMLElement>('li[data-title]');
  if (li) setFocus('list', { kind: 'places', titles: [li.dataset.title!] });
});
listEl.addEventListener('focusout', () => setFocus('list', null));

// ------------------------------------------------------------------ shared focus (two-way hover)

type Source = 'globe' | 'list' | 'article' | 'timeline';
type Focus = { kind: 'places'; titles: string[] } | { kind: 'year'; year: number };

let focusSource: Source | null = null;
let focusKey = '';
let turnTimer: number | undefined;

/**
 * One place (or year) is "in focus" at a time, whichever pane the pointer is on.
 * Every other pane mirrors it: pins ring, article mentions light up, the list row
 * highlights, and the globe turns towards places hovered elsewhere.
 */
function setFocus(source: Source, focus: Focus | null) {
  if (!focus && focusSource !== source) return; // a stale "leave" from another pane
  const key = focus ? `${source}|${focus.kind === 'year' ? focus.year : focus.titles.join('\n')}` : '';
  if (key === focusKey) return; // same thing still hovered
  focusKey = key;
  focusSource = focus ? source : null;
  window.clearTimeout(turnTimer);

  // Clear previous marks.
  bodyEl.querySelectorAll('.hl').forEach((x) => x.classList.remove('hl'));
  listEl.querySelectorAll('li.hl').forEach((x) => x.classList.remove('hl'));
  if (source !== 'timeline') timeline.highlight(null);

  if (!focus) {
    globe?.highlight([]);
    if (source !== 'globe') globe?.preview(null);
    hideChip();
    return;
  }

  globe?.stopSpin(); // anything in focus should stay where the user can see it
  let titles: string[];
  let mentions: HTMLElement[];
  if (focus.kind === 'places') {
    titles = focus.titles;
    const sel = titles.map((t) => `a[data-place="${CSS.escape(t)}"]`).join(',');
    mentions = sel ? [...bodyEl.querySelectorAll<HTMLElement>(sel)] : [];
  } else {
    const info = view.years.get(focus.year);
    mentions = info?.spans ?? [];
    // Places mentioned in the same sentences as the year.
    const near = new Set<string>();
    for (const span of mentions) {
      for (const a of sameSentence(span, 'a[data-place]')) near.add((a as HTMLElement).dataset.place!);
    }
    titles = [...near];
    if (source !== 'timeline') timeline.highlight(focus.year, false);
  }

  for (const m of mentions) m.classList.add('hl');
  const places = titles.map((t) => view.ranked.get(t) ?? view.shown.get(t)).filter((p): p is ScoredPlace => !!p);

  // Globe: ring the places; a single place hovered elsewhere also gets its card and a turn.
  if (source !== 'globe' || focus.kind === 'year') globe?.highlight(places);
  else globe?.highlight([]); // the globe shows its own hover
  if (source !== 'globe' && focus.kind === 'places' && places.length === 1) {
    globe?.preview(places[0]);
    const p = places[0];
    // Wait a moment so sweeping the pointer across a paragraph doesn't swing the globe around.
    turnTimer = window.setTimeout(() => globe?.turnTo(p), source === 'article' ? 180 : 60);
  } else if (source !== 'globe') {
    globe?.preview(null);
  }

  // List: highlight rows and keep the first one in view.
  const rows = titles.map((t) => listEl.querySelector<HTMLElement>(`li[data-title="${CSS.escape(t)}"]`)).filter(Boolean) as HTMLElement[];
  rows.forEach((r) => r.classList.add('hl'));
  if (source !== 'list' && rows[0]) rows[0].scrollIntoView({ block: 'nearest' });

  // Article: if none of the mentions are on screen, say where they are.
  if (source !== 'article') showChip(mentions);
  else hideChip();
}

// Article hover -> focus. Place links and year mentions both count.
bodyEl.addEventListener('mouseover', (e) => {
  const t = e.target as Element;
  const a = t.closest<HTMLElement>('a[data-place]');
  if (a) return setFocus('article', { kind: 'places', titles: [a.dataset.place!] });
  const yr = t.closest<HTMLElement>('.yr');
  if (yr && view.years.has(Number(yr.dataset.year))) {
    const year = Number(yr.dataset.year);
    setFocus('article', { kind: 'year', year });
    timeline.highlight(year, false);
  }
});
bodyEl.addEventListener('mouseout', (e) => {
  const from = (e.target as Element).closest('a[data-place], .yr');
  const to = (e.relatedTarget as Element | null)?.closest?.('a[data-place], .yr');
  if (from && from !== to) setFocus('article', null);
});

// ------------------------------------------------------------------ "mentions below" chip

let chipTargets: HTMLElement[] = [];
let chipHideTimer: number | undefined;

function showChip(mentions: HTMLElement[]) {
  window.clearTimeout(chipHideTimer);
  if (!mentions.length) return hideChip(true);
  const r = pane.getBoundingClientRect();
  const visible = mentions.some((m) => {
    const b = m.getBoundingClientRect();
    return b.bottom > r.top + 40 && b.top < r.bottom - 10 && b.width > 0;
  });
  if (visible) return hideChip(true);
  const below = mentions.filter((m) => m.getBoundingClientRect().top >= r.bottom - 10);
  const above = mentions.filter((m) => m.getBoundingClientRect().bottom <= r.top + 40);
  const down = below.length >= 1;
  chipTargets = down ? below : above.reverse();
  const n = mentions.length;
  chip.textContent = `${down ? '↓' : '↑'} ${n} mention${n === 1 ? '' : 's'} ${down ? 'below' : 'above'}`;
  chip.dataset.dir = down ? 'down' : 'up';
  chip.hidden = false;
  positionChip();
}

/** Hides the chip after a pause (so it can still be clicked after leaving the pin). */
function hideChip(now = false) {
  window.clearTimeout(chipHideTimer);
  if (now || chip.hidden) {
    chip.hidden = true;
    return;
  }
  chipHideTimer = window.setTimeout(() => { if (!chip.matches(':hover')) chip.hidden = true; }, 1800);
}

function positionChip() {
  if (chip.hidden) return;
  const r = pane.getBoundingClientRect();
  chip.style.left = `${r.left + r.width / 2}px`;
  chip.style.top = chip.dataset.dir === 'down' ? `${r.bottom - 52}px` : `${r.top + 12}px`;
}

chip.addEventListener('click', () => {
  if (chipTargets[0]) scrollToEl(chipTargets[0]);
  chip.hidden = true;
});
chip.addEventListener('mouseleave', () => hideChip());
pane.addEventListener('scroll', () => { if (!chip.hidden && !focusSource) chip.hidden = true; }, { passive: true });

// ------------------------------------------------------------------ scrolling

function scrollToEl(el: HTMLElement) {
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('mention-flash');
  void el.offsetWidth; // restart the animation
  el.classList.add('mention-flash');
}

// ------------------------------------------------------------------ selection

/**
 * The clicked place or year. Its mentions stay marked in the article, and clicking
 * the same pin, row or year again steps to its next mention.
 */
let selection: { key: string; els: HTMLElement[]; idx: number } | null = null;
let posTimer: number | undefined;

function selectPlace(title: string) {
  timeline.setSelected(null);
  const p = view.ranked.get(title) ?? view.shown.get(title);
  const els = [...bodyEl.querySelectorAll<HTMLElement>(`a[data-place="${CSS.escape(title)}"]`)];
  // Start where the card's snippet is quoted, then go through the rest in reading order.
  const first = p && view.index?.firstMention(p);
  selectMentions(`place:${title}`, els, first);
  listEl.querySelectorAll('li.sel').forEach((x) => x.classList.remove('sel'));
  listEl.querySelector(`li[data-title="${CSS.escape(title)}"]`)?.classList.add('sel');
}

function selectMentions(key: string, els: HTMLElement[], start?: HTMLElement) {
  if (selection?.key === key && selection.els.length) {
    selection.idx = (selection.idx + 1) % selection.els.length;
  } else {
    clearSelection(false);
    // Visit order starts at `start` and wraps round, so the first click is "1 of n".
    const i = Math.max(start ? els.indexOf(start) : 0, 0);
    selection = { key, els: [...els.slice(i), ...els.slice(0, i)], idx: 0 };
    for (const el of els) el.classList.add('sel');
  }
  const el = selection.els[selection.idx];
  if (!el) return;
  scrollToEl(el);
  showPosition(selection.idx + 1, selection.els.length);
}

function clearSelection(all = true) {
  for (const el of selection?.els ?? []) el.classList.remove('sel');
  selection = null;
  listEl.querySelectorAll('li.sel').forEach((x) => x.classList.remove('sel'));
  timeline.setSelected(null);
  posBadge.hidden = true;
  if (all) globe?.deselect();
}

/** "Mention 2 of 5" badge at the top of the article. */
function showPosition(n: number, total: number) {
  window.clearTimeout(posTimer);
  if (total < 2) {
    posBadge.hidden = true;
    return;
  }
  posBadge.textContent = `Mention ${n} of ${total} · click again for the next`;
  posBadge.hidden = false;
  const r = pane.getBoundingClientRect();
  posBadge.style.left = `${r.left + r.width / 2}px`;
  posBadge.style.top = `${r.top + 12}px`;
  posTimer = window.setTimeout(() => { posBadge.hidden = true; }, 2600);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selection && !(e.target as Element).closest('input')) clearSelection();
});

function setSourceLink(title: string) {
  const a = document.createElement('a');
  a.href = wikipediaUrl(title);
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = `Read or edit “${title}” on Wikipedia`;
  sourceLink.replaceChildren(a, document.createTextNode('.'));
}

function onViewOptionChange() {
  topNOut.value = topN.value;
  if (view.data) history.replaceState(null, '', urlFor(view.data.title, true));
  renderPlaces(false);
}
topN.addEventListener('input', onViewOptionChange);

// Exposed for debugging in dev.
if (import.meta.env.DEV) (window as any).__view = () => view;

// ------------------------------------------------------------------ boot

for (const form of document.querySelectorAll<HTMLFormElement>('form.search')) {
  attachSearch(form, navigate);
}
route();
