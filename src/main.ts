import './style.css';
import { Globe } from './globe';
import { attachSearch } from './search';
import { filterPlaces, isLargeRegion } from './filter';
import {
  getSummary, loadArticle, NotFoundError, parseTitleInput, toPageParam, wikipediaUrl, type ArticleData,
} from './wiki';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const landing = $('landing');
const viewer = $('viewer');
const topSearch = document.querySelector<HTMLFormElement>('.search-top')!;
const titleEl = $('article-title');
const descEl = $('article-desc');
const countEl = $('place-count');
const summaryEl = $('article-summary');
const statusEl = $('globe-status');
const showLarge = $<HTMLInputElement>('show-large');
const sourceLink = $('source-link');

let globe: Globe | undefined;
let current: ArticleData | undefined;
let loadCtrl: AbortController | undefined;

// ------------------------------------------------------------------ routing

function pageFromUrl(): string | null {
  const p = new URLSearchParams(location.search).get('page');
  return p ? parseTitleInput(p) : null;
}

function urlFor(title: string) {
  return `?page=${encodeURIComponent(toPageParam(title)).replace(/%2F/g, '/')}`;
}

function navigate(title: string) {
  history.pushState(null, '', urlFor(title));
  route();
}

function route() {
  const page = pageFromUrl();
  if (page) showArticle(page);
  else showLanding();
}

window.addEventListener('popstate', route);

// Same-origin ?page= links (examples, brand) are handled in-app.
document.addEventListener('click', (e) => {
  const a = (e.target as Element).closest('a');
  if (!a || a.target === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname !== location.pathname) return;
  e.preventDefault();
  history.pushState(null, '', url.search || location.pathname);
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
  globe ??= new Globe($('globe'), { onOpen: navigate });

  loadCtrl?.abort();
  const ctrl = (loadCtrl = new AbortController());
  current = undefined;
  titleEl.textContent = input;
  descEl.textContent = '';
  countEl.textContent = '';
  summaryEl.replaceChildren();
  setStatus('Finding places…');
  document.title = `${input} · Wikipedia Globe`;

  globe.placeCamera([], undefined);
  let cameraPlaced = false;
  let summaryStarted = false;

  try {
    const data = await loadArticle(input, ctrl.signal, (p) => {
      // Progressive: draw pins as each batch of links arrives.
      if (ctrl.signal.aborted) return;
      current = p;
      if (!summaryStarted) {
        summaryStarted = true;
        showTitle(p.title, ctrl.signal);
      }
      if (!cameraPlaced && p.primary) {
        globe!.placeCamera(p.places, p.primary);
        cameraPlaced = true;
      }
      renderPlaces(true);
    });
    if (ctrl.signal.aborted) return;
    current = data;
    if (!summaryStarted) showTitle(data.title, ctrl.signal);
    // Without a primary coordinate, fit to the full set once it's in (unless the user already took over).
    if (!cameraPlaced) globe.placeCamera(filterPlaces(data.places, showLarge.checked), data.primary, true);
    await renderPlaces(false);
  } catch (err) {
    if (ctrl.signal.aborted) return;
    console.error(err);
    await globe.setPlaces([], undefined);
    if (err instanceof NotFoundError) {
      titleEl.textContent = input;
      setStatus(`There's no English Wikipedia article called “${input}”.`, 'error');
    } else {
      setStatus('Couldn’t reach Wikipedia. Check your connection and try again.', 'error');
    }
  }
}

function showTitle(title: string, signal: AbortSignal) {
  if (title !== pageFromUrl()) history.replaceState(null, '', urlFor(title));
  titleEl.textContent = title;
  document.title = `${title} · Wikipedia Globe`;
  setSourceLink(title);
  renderSummary(title, signal);
}

/** `loading`: more batches are on the way, so don't show the empty state yet. */
async function renderPlaces(loading: boolean) {
  if (!current || !globe) return;
  const places = filterPlaces(current.places, showLarge.checked);
  const hiddenLarge = current.places.filter(isLargeRegion).length;
  countEl.textContent =
    `${places.length} mapped place${places.length === 1 ? '' : 's'}` +
    (loading ? ' so far…' : '') +
    (!showLarge.checked && hiddenLarge ? ` (${hiddenLarge} large region${hiddenLarge === 1 ? '' : 's'} hidden)` : '');

  await globe.setPlaces(places, current.primary);

  if (places.length || current.primary) {
    setStatus(null);
  } else if (!loading) {
    setStatus(
      hiddenLarge && !showLarge.checked
        ? 'This article only links to countries or large regions. Turn on “Show countries & large regions” to see them.'
        : 'No mapped locations. None of the places this article links to have coordinates on Wikipedia.',
      'empty',
    );
  }
}

async function renderSummary(title: string, signal: AbortSignal) {
  try {
    const s = await getSummary(title);
    if (signal.aborted) return;
    descEl.textContent = s.description ?? '';
    const frag = document.createDocumentFragment();
    if (s.thumbnail) {
      const img = document.createElement('img');
      img.src = s.thumbnail.source;
      img.alt = '';
      img.className = 'summary-thumb';
      frag.append(img);
    }
    if (s.extract) {
      const p = document.createElement('p');
      p.textContent = s.extract;
      frag.append(p);
    }
    summaryEl.replaceChildren(frag);
  } catch {
    /* summary is decoration in phase 1 */
  }
}

function setSourceLink(title: string) {
  const a = document.createElement('a');
  a.href = wikipediaUrl(title);
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = `Read “${title}” on Wikipedia`;
  sourceLink.replaceChildren(a, document.createTextNode('.'));
}

showLarge.addEventListener('change', () => renderPlaces(false));

// ------------------------------------------------------------------ boot

for (const form of document.querySelectorAll<HTMLFormElement>('form.search')) {
  attachSearch(form, navigate);
}
route();
