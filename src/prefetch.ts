import { loadArticleHtml } from './article';
import { loadArticle, parseTitleInput } from './wiki';

/**
 * Starts loading an article when the pointer rests on a link to it, so most of a first
 * visit's wait happens before the click. Results land in the normal caches; a click while
 * the prefetch is still running shares the same requests.
 */
const HOVER_MS = 200;
/** At most this many articles prefetching at once, to stay polite to Wikipedia. */
const MAX_ACTIVE = 2;

let active = 0;
const started = new Set<string>();

function prefetch(title: string) {
  const key = title.toLowerCase();
  if (started.has(key) || active >= MAX_ACTIVE) return;
  started.add(key);
  active++;
  // Failures (a missing page, no network) are ignored here; a click shows them properly.
  Promise.allSettled([loadArticle(title), loadArticleHtml(title)]).finally(() => active--);
}

/** The in-app article a link points at (`?page=…`), or null. */
function linkTitle(a: HTMLAnchorElement): string | null {
  if (a.target === '_blank') return null;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname !== location.pathname) return null;
  const page = url.searchParams.get('page');
  return page ? parseTitleInput(page) : null;
}

export function initPrefetch() {
  const conn = (navigator as { connection?: { saveData?: boolean } }).connection;
  if (conn?.saveData) return;
  let timer = 0;
  document.addEventListener('mouseover', (e) => {
    const a = (e.target as Element).closest?.('a');
    if (!a) return;
    const title = linkTitle(a);
    if (!title || title === new URLSearchParams(location.search).get('page')) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => prefetch(title), HOVER_MS);
  });
  document.addEventListener('mouseout', (e) => {
    if ((e.target as Element).closest?.('a')) clearTimeout(timer);
  });
  // Keyboard users: focusing a link is the same signal as hovering it.
  document.addEventListener('focusin', (e) => {
    const a = (e.target as Element).closest?.('a');
    const title = a && linkTitle(a);
    if (title) prefetch(title);
  });
}

/** For the search box: prefetch the suggestion the user has highlighted. */
export { prefetch };
