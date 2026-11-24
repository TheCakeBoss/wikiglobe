import './style.css';
import { Globe, type GlobePlace } from './globe';
import { attachSearch } from './search';
import { filterPlaces } from './filter';
import { loadArticleHtml } from './article';
import { ArticleIndex, type ScoredPlace } from './relevance';
import {
  getSummary, loadArticle, NotFoundError, parseTitleInput, toPageParam, wikipediaUrl, type ArticleData, type Place,
} from './wiki';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const landing = $('landing');
const viewer = $('viewer');
const pane = document.querySelector<HTMLElement>('.article-pane')!;
const topSearch = document.querySelector<HTMLFormElement>('.search-top')!;
const titleEl = $('article-title');
const descEl = $('article-desc');
const countEl = $('place-count');
const bodyEl = $('article-body');
const statusEl = $('globe-status');
const showLarge = $<HTMLInputElement>('show-large');
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
  /** Places by title for the pins currently shown. */
  shown: Map<string, GlobePlace>;
}

let globe: Globe | undefined;
let view: View = { shown: new Map() };
let loadCtrl: AbortController | undefined;

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
  if (showLarge.checked) q.set('large', '1');
  return `?${q.toString().replace(/%2F/g, '/')}${keepHash ? location.hash : ''}`;
}

function readViewOptions() {
  const q = new URLSearchParams(location.search);
  const n = Number(q.get('n'));
  topN.value = String(n >= 10 && n <= 200 ? n : DEFAULT_TOP_N);
  topNOut.value = topN.value;
  showLarge.checked = q.get('large') === '1';
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
  globe ??= new Globe($('globe'), { onOpen: navigate, onSelect: scrollToMention });

  loadCtrl?.abort();
  const ctrl = (loadCtrl = new AbortController());
  const v: View = (view = { shown: new Map() });
  titleEl.textContent = input;
  descEl.textContent = '';
  countEl.textContent = '';
  bodyEl.replaceChildren();
  bodyEl.classList.add('loading');
  pane.scrollTop = 0;
  setStatus('Finding places…');
  document.title = `${input} · Wikipedia Globe`;

  globe.placeCamera([], undefined);
  let cameraPlaced = false;
  let titleShown = false;
  const live = () => !ctrl.signal.aborted && view === v;

  // Article HTML and place coordinates load in parallel.
  const htmlP = loadArticleHtml(input, ctrl.signal).then(
    (html) => {
      if (!live()) return;
      renderArticle(html);
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
        globe!.placeCamera([], p.primary);
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
    // Without a primary coordinate, fit to the pins once they're all in (unless the user took over).
    if (!cameraPlaced) globe.placeCamera(shown, data.primary, true);
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
  document.title = `${title} · Wikipedia Globe`;
  setSourceLink(title);
  getSummary(title).then(
    (s) => { if (!signal.aborted) descEl.textContent = s.description ?? ''; },
    () => {},
  );
}

function renderArticle(html: string) {
  bodyEl.classList.remove('loading');
  bodyEl.innerHTML = html; // sanitised by DOMPurify in loadArticleHtml
  if (location.hash) {
    document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
  }
}

/**
 * Ranks places and updates pins + count. `loading`: more batches may arrive.
 * Returns the places now pinned.
 */
function renderPlaces(loading: boolean): GlobePlace[] {
  const v = view;
  const data = v.data;
  if (!data || !globe) return [];
  if (!v.index && !v.htmlFailed) return []; // wait for the article so we can rank

  const candidates = filterPlaces(data.places, showLarge.checked);
  const hiddenLarge = data.places.length - candidates.length;
  const n = Number(topN.value);

  let pins: GlobePlace[];
  let total: number;
  let unlinked = 0;
  if (v.index) {
    const { ranked, unlinked: u } = v.index.score(candidates);
    unlinked = u.length;
    total = ranked.length;
    pins = withWeights(ranked.slice(0, n));
  } else {
    total = candidates.length;
    pins = candidates.slice(0, n);
  }
  v.shown = new Map(pins.map((p) => [p.title, p]));

  const parts = [
    total > pins.length
      ? `Top ${pins.length} of ${total} places`
      : `${pins.length} place${pins.length === 1 ? '' : 's'}`,
  ];
  if (loading) parts[0] += ' so far…';
  const hidden = [
    hiddenLarge && !showLarge.checked ? `${hiddenLarge} large region${hiddenLarge === 1 ? '' : 's'}` : '',
    unlinked ? `${unlinked} only in references or navigation` : '',
  ].filter(Boolean);
  countEl.textContent = parts[0] + (hidden.length ? ` · hidden: ${hidden.join(', ')}` : '');
  topN.disabled = total <= 10;

  globe.setPlaces(pins, data.primary);

  if (pins.length || data.primary) {
    setStatus(null);
  } else if (!loading) {
    setStatus(
      hiddenLarge && !showLarge.checked && !unlinked
        ? 'This article only links to countries or large regions. Turn on “Countries & large regions” to see them.'
        : 'No mapped locations. None of the places this article mentions have coordinates on Wikipedia.',
      'empty',
    );
  }
  return pins;
}

/** Map scores to 0..1 pin weights (square-root, so mid-ranked places stay visible). */
function withWeights(places: ScoredPlace[]): GlobePlace[] {
  const max = places[0]?.score ?? 1;
  const min = places[places.length - 1]?.score ?? 0;
  return places.map((p) => ({ ...p, weight: max > min ? Math.sqrt((p.score - min) / (max - min)) : 1 }));
}

function scrollToMention(title: string) {
  const p = view.shown.get(title) as Place | undefined;
  const a = p && view.index?.firstMention(p);
  if (!a) return;
  a.scrollIntoView({ behavior: 'smooth', block: 'center' });
  a.classList.remove('mention-flash');
  void a.offsetWidth; // restart the animation
  a.classList.add('mention-flash');
}

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
showLarge.addEventListener('change', onViewOptionChange);

// Exposed for debugging in dev.
if (import.meta.env.DEV) (window as any).__view = () => view;

// ------------------------------------------------------------------ boot

for (const form of document.querySelectorAll<HTMLFormElement>('form.search')) {
  attachSearch(form, navigate);
}
route();
