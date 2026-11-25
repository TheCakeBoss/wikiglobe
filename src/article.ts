import DOMPurify from 'dompurify';
import { PAGE_REST_API, WIKI_HOST } from './config';
import { bigCacheGet, bigCacheSet } from './cache';
import { NotFoundError, toPageParam } from './wiki';

/**
 * Elements we drop before rendering: navigation boxes, maintenance banners and
 * other chrome that only makes sense on wikipedia.org.
 */
const REMOVE = [
  'link', 'meta', 'style', 'script',
  '.navbox', '.navbox-styles', '.vertical-navbox', '.authority-control',
  '.ambox', '.ombox', '.mbox-small', '.metadata', '.noprint', '.mw-empty-elt',
  '.shortdescription', '.sistersitebox', '.portalbox', '.portal', '.side-box',
  '.mw-editsection', '.mw-cite-backlink',
  // "Part of a series" sidebars are navigation, like navboxes.
  '.sidebar',
  // Kartographer maps are images from maps.wikimedia.org, which refuses other sites. The globe covers it.
  '.mw-kartographer-container', '.mw-kartographer-map', '[typeof~="mw:Extension/mapframe"]',
].join(',');

/**
 * Regions that don't count towards relevance (but are still shown): reference lists,
 * sidebars, and everything in trailing sections like "See also".
 */
export const NON_PROSE = [
  '.mw-references-wrap', '.reflist', '.refbegin', 'ol.references', '.mw-ref',
  '[data-trailing-section]',
].join(',');

const TRAILING_SECTIONS = new Set([
  'see also', 'notes', 'footnotes', 'references', 'citations', 'sources', 'bibliography',
  'further reading', 'external links', 'works cited', 'notes and references', 'general and cited sources',
  'explanatory notes', 'general sources', 'cited sources', 'literature',
]);

const htmlJobs = new Map<string, Promise<string>>();

/**
 * Fetches Parsoid HTML, sanitises and cleans it. Returns HTML for the article body.
 * A fetch already in flight (for example a hover prefetch) is shared, and isn't cancelled
 * when the caller navigates away, so its result still lands in the cache.
 */
export function loadArticleHtml(title: string): Promise<string> {
  const key = `html6:${title}`;
  let job = htmlJobs.get(key);
  if (!job) {
    job = (async () => (await bigCacheGet<string>(key)) ?? fetchArticleHtml(title, key))()
      .finally(() => htmlJobs.delete(key));
    htmlJobs.set(key, job);
  }
  return job;
}

async function fetchArticleHtml(title: string, key: string): Promise<string> {
  const res = await fetch(`${PAGE_REST_API}/${encodeURIComponent(toPageParam(title))}/html`);
  if (res.status === 404) throw new NotFoundError(title);
  if (!res.ok) throw new Error(`article html ${res.status}`);
  const raw = await res.text();
  // Footnote links use the canonical title, which differs from `title` if it was a redirect.
  const canonical = raw.match(/<title>([^<]*)<\/title>/)?.[1]
    ?.replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, '');
  const html = cleanHtml(raw, canonical || title);
  void bigCacheSet(key, html);
  return html;
}

function cleanHtml(raw: string, title: string): string {
  // DOMPurify drops rel="mw:WikiLink" (it reads "mw:" as a URL scheme), so turn the
  // article-link marker into a data attribute first.
  raw = raw.replace(/\brel="mw:WikiLink"/g, 'data-wl=""');
  // Drop Parsoid bookkeeping before parsing: about a third of the page by size (Melbourne:
  // ~530 KB of 1.4 MB), so the sanitiser and every later step have much less to chew on.
  raw = raw
    .replace(/\s(?:data-mw|data-mw-i18n|data-mw-wikitext|about|resource|data-file-type)=(?:"[^"]*"|'[^']*')/g, '')
    .replace(/\sid="mw[\w-]{2,4}"/g, '');
  // Sanitise; everything after operates on inert, safe nodes.
  const body = DOMPurify.sanitize(raw, {
    WHOLE_DOCUMENT: false,
    RETURN_DOM: true,
    FORBID_TAGS: ['style', 'link', 'meta', 'form', 'input', 'button'],
    ADD_ATTR: ['typeof'],
  }) as HTMLElement;

  body.querySelectorAll(REMOVE).forEach((el) => el.remove());
  // Infobox rows left empty by the removals above (e.g. the map row).
  body.querySelectorAll('.infobox tr').forEach((tr) => {
    if (!tr.textContent!.trim() && !tr.querySelector('img')) tr.remove();
  });

  // Mark trailing sections ("See also", "References", ...) so they can be styled and excluded.
  body.querySelectorAll('section').forEach((sec) => {
    const h = sec.querySelector(':scope > h2, :scope > .mw-heading > h2');
    if (h && TRAILING_SECTIONS.has(h.textContent!.trim().toLowerCase())) sec.setAttribute('data-trailing-section', '');
  });

  rewriteLinks(body, title);
  fixMedia(body);
  return body.innerHTML;
}

/** Title from a Parsoid href like "./Anzac_Cove#Landing" (null for non-article links). */
export function titleFromHref(href: string | null): { title: string; hash: string } | null {
  if (!href?.startsWith('./')) return null;
  const [path, hash = ''] = href.slice(2).split('#');
  const clean = path.split('?')[0];
  if (!clean) return null;
  return { title: decodeURIComponent(clean).replace(/_/g, ' '), hash };
}

/** Non-article namespaces; titles like "Star Wars: Episode IV" must not match. */
const NAMESPACE_RE =
  /^(File|Image|Media|Category|Help|Wikipedia|WP|Template|Portal|Special|Talk|User|Module|Draft|MOS|Book|TimedText|MediaWiki)( talk)?:/i;

function rewriteLinks(root: HTMLElement, articleTitle: string) {
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = a.getAttribute('href')!;
    const t = titleFromHref(href);

    if (t && t.title === articleTitle && t.hash) {
      a.setAttribute('href', `#${t.hash}`); // footnote jumps stay in-page
      continue;
    }
    if (a.hasAttribute('data-wl') && t) {
      if (a.classList.contains('new')) {
        // Red link: the article doesn't exist. Render as plain text.
        const span = document.createElement('span');
        span.append(...a.childNodes);
        a.replaceWith(span);
        continue;
      }
      if (NAMESPACE_RE.test(t.title)) {
        // Namespaced page (File:, Help:, Category: ...): send to Wikipedia.
        a.href = `${WIKI_HOST}/wiki/${toPageParam(t.title)}${t.hash ? '#' + t.hash : ''}`;
        a.target = '_blank';
        a.rel = 'noopener';
        continue;
      }
      a.setAttribute('href', `?page=${encodeURIComponent(toPageParam(t.title))}${t.hash ? '#' + t.hash : ''}`);
      a.setAttribute('data-title', t.title);
      a.className = 'wl';
      a.removeAttribute('data-wl');
      continue;
    }
    if (t) {
      // Other "./" links (e.g. file description pages without the WikiLink rel).
      a.href = `${WIKI_HOST}/wiki/${toPageParam(t.title)}`;
    } else if (href.startsWith('//')) {
      a.href = 'https:' + href;
    }
    if (!href.startsWith('#')) {
      a.target = '_blank';
      a.rel = 'noopener';
    }
  }
}

function fixMedia(root: HTMLElement) {
  const abs = (u: string) => (u.startsWith('//') ? 'https:' + u : u);
  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('src');
    if (src) img.setAttribute('src', abs(src));
    // One resolution only: the 1.5x/2x versions in srcset roughly double image downloads on
    // high-DPI screens, for article thumbnails that are already small.
    img.removeAttribute('srcset');
    img.setAttribute('loading', 'lazy');
  }
  // Audio/video players need Wikipedia's JS; drop them.
  root.querySelectorAll('video, audio').forEach((el) => el.closest('figure, span[typeof]')?.remove() ?? el.remove());
}
