import { ACTION_API, REST_API, WIKI_HOST } from './config';
import { bigCacheGet, bigCacheSet, cacheGet, cacheSet } from './cache';

export interface Coord {
  lat: number;
  lon: number;
  type?: string;
  dim?: number;
  globe: string;
}

export interface Place {
  title: string;
  lat: number;
  lon: number;
  type?: string;
  dim?: number;
  /** Redirect titles the article links through (needed to match links in the HTML in phase 2). */
  aliases?: string[];
}

export interface ArticleData {
  /** Canonical title after redirects/normalisation. */
  title: string;
  primary?: { lat: number; lon: number };
  /** Every linked article with an Earth coordinate (unfiltered). */
  places: Place[];
}

export interface Summary {
  title: string;
  description?: string;
  extract?: string;
  thumbnail?: { source: string; width: number; height: number };
}

export class NotFoundError extends Error {}


async function actionQuery(params: Record<string, string>, signal?: AbortSignal): Promise<any> {
  const url = new URL(ACTION_API);
  url.search = new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params }).toString();
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Wikipedia API error ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.info ?? 'Wikipedia API error');
  return json;
}

/** Accepts a title ("Gallipoli campaign", "Gallipoli_campaign") or a full Wikipedia URL. */
export function parseTitleInput(input: string): string {
  const s = input.trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    if (/wikipedia\.org$/.test(u.hostname)) {
      const m = u.pathname.match(/^\/wiki\/(.+)$/);
      if (m) return decodeURIComponent(m[1]).replace(/_/g, ' ');
      const t = u.searchParams.get('title');
      if (t) return t.replace(/_/g, ' ');
    }
  } catch {
    /* not a URL */
  }
  return s.replace(/_/g, ' ');
}

export const toPageParam = (title: string) => title.replace(/ /g, '_');
export const wikipediaUrl = (title: string) => `${WIKI_HOST}/wiki/${encodeURIComponent(toPageParam(title))}`;

// ---------------------------------------------------------------- autocomplete

export async function opensearch(q: string, signal?: AbortSignal): Promise<string[]> {
  const key = `os:${q.toLowerCase()}`;
  const hit = cacheGet<string[]>(key, false);
  if (hit) return hit;
  const url = new URL(ACTION_API);
  url.search = new URLSearchParams({
    action: 'opensearch', search: q, limit: '8', namespace: '0', format: 'json', origin: '*',
  }).toString();
  const res = await fetch(url, { signal });
  const json = (await res.json()) as [string, string[]];
  cacheSet(key, json[1], false);
  return json[1];
}

// ---------------------------------------------------------------- article data

const pickEarth = (coords?: Coord[]) =>
  coords?.find((c) => (c.globe ?? 'earth').toLowerCase() === 'earth');

/** Resolves the canonical title and the article's own primary coordinate. */
async function fetchPrimary(title: string, signal?: AbortSignal) {
  const json = await actionQuery(
    { action: 'query', titles: title, redirects: '1', prop: 'coordinates', coprop: 'type|dim|globe' },
    signal,
  );
  const page = json.query?.pages?.[0];
  if (!page || page.missing || page.invalid) throw new NotFoundError(title);
  const c = pickEarth(page.coordinates);
  return { title: page.title as string, primary: c ? { lat: c.lat, lon: c.lon } : undefined };
}

/**
 * All linked articles with coordinates. Wikipedia returns links 500 at a time and only says
 * where the next batch starts once the previous one has arrived, so a link-heavy article
 * (Melbourne has ~1,600 links) needs several round trips. To halve that, two chains run at
 * once, one from A forwards and one from Z backwards, and stop when they meet.
 * `onBatch` gets the places found so far after each response, so pins can appear early.
 */
async function fetchLinkedPlaces(
  title: string,
  signal?: AbortSignal,
  onBatch?: (placesSoFar: Place[]) => void,
): Promise<Place[]> {
  const pages = new Map<number, { title: string; coords: Coord[] }>();
  const aliases = new Map<string, Set<string>>();
  // Which chain first saw each page; a chain stops once it reaches pages the other has seen.
  const seenBy = new Map<number, 'asc' | 'desc'>();
  let met = false;
  // Once the chains meet, the other chain's request in flight is no longer needed.
  const stop = new AbortController();
  signal?.addEventListener('abort', () => stop.abort());

  const collect = (): Place[] => {
    const places: Place[] = [];
    for (const { title: t, coords } of pages.values()) {
      if (t === title) continue;
      const c = pickEarth(coords); // drops Moon/Mars/etc.
      if (!c) continue;
      const a = aliases.get(t);
      places.push({ title: t, lat: c.lat, lon: c.lon, type: c.type, dim: c.dim, ...(a && { aliases: [...a] }) });
    }
    return places;
  };

  const chain = async (dir: 'asc' | 'desc') => {
    let cont: Record<string, string> = {};
    for (let guard = 0; guard < 50 && !met; guard++) {
      let json;
      try {
        json = await actionQuery(
          {
            action: 'query',
            generator: 'links',
            titles: title,
            gplnamespace: '0',
            gpllimit: 'max',
            gpldir: dir === 'asc' ? 'ascending' : 'descending',
            // Resolves the input title if it's a redirect, and redirecting links
            // ("Anzac Cove" -> "ANZAC Cove") so they get coordinates.
            redirects: '1',
            prop: 'coordinates',
            colimit: 'max',
            coprop: 'type|dim|globe',
            ...cont,
          },
          stop.signal,
        );
      } catch (err) {
        if (met && !signal?.aborted) return; // cancelled because the other chain finished the job
        throw err;
      }
      if (met) return;
      for (const r of json.query?.redirects ?? []) {
        if (!aliases.has(r.to)) aliases.set(r.to, new Set());
        aliases.get(r.to)!.add(r.from);
      }
      // Only pages linked directly count towards meeting: a redirect ("Birrarung" -> "Yarra
      // River") can land anywhere in the alphabet.
      const viaRedirect = new Set<string>((json.query?.redirects ?? []).map((r: { to: string }) => r.to));
      let overlap = false;
      for (const p of json.query?.pages ?? []) {
        if (p.missing) continue;
        if (!viaRedirect.has(p.title)) {
          const by = seenBy.get(p.pageid);
          if (by && by !== dir) overlap = true;
          else if (!by) seenBy.set(p.pageid, dir);
        }
        const entry = pages.get(p.pageid) ?? { title: p.title as string, coords: [] as Coord[] };
        // The same page can arrive from both chains; keep its coordinates once.
        if (p.coordinates && !entry.coords.length) entry.coords.push(...p.coordinates);
        pages.set(p.pageid, entry);
      }
      // A coordinate-only continuation (cocontinue) must be followed to finish this batch.
      if (!json.continue || (overlap && !json.continue.cocontinue)) {
        met = true;
        stop.abort();
        break;
      }
      cont = json.continue;
      onBatch?.(collect());
    }
  };
  await Promise.all([chain('asc'), chain('desc')]);
  return collect();
}

export interface LoadProgress {
  title: string;
  primary?: { lat: number; lon: number };
  places: Place[];
}

/**
 * Loads an article's primary coordinate and linked places. The two queries run in
 * parallel; `onProgress` fires once the primary is known and again per batch of links.
 * A load already in flight (for example a hover prefetch) is shared rather than repeated,
 * and keeps going if the caller navigates away, so its result still lands in the cache.
 */
export function loadArticle(
  input: string,
  signal?: AbortSignal,
  onProgress?: (p: LoadProgress) => void,
): Promise<ArticleData> {
  const key = `art:${input.toLowerCase()}`;
  let job = articleJobs.get(key);
  if (!job) {
    const j: ArticleJob = { listeners: new Set(), promise: undefined! };
    const report = (p: LoadProgress) => {
      j.latest = p;
      j.listeners.forEach((l) => l(p));
    };
    j.promise = (async () => (await bigCacheGet<ArticleData>(key)) ?? fetchArticle(input, report))()
      .finally(() => articleJobs.delete(key));
    articleJobs.set(key, (job = j));
  }
  if (onProgress) {
    const j = job;
    if (j.latest) onProgress(j.latest);
    j.listeners.add(onProgress);
    signal?.addEventListener('abort', () => j.listeners.delete(onProgress));
    j.promise.finally(() => j.listeners.delete(onProgress));
  }
  return job.promise;
}

interface ArticleJob {
  promise: Promise<ArticleData>;
  listeners: Set<(p: LoadProgress) => void>;
  latest?: LoadProgress;
}
const articleJobs = new Map<string, ArticleJob>();

async function fetchArticle(input: string, onProgress: (p: LoadProgress) => void): Promise<ArticleData> {
  const key = `art:${input.toLowerCase()}`;
  const primaryP = fetchPrimary(input);
  let latest: Place[] = [];
  let head: { title: string; primary?: { lat: number; lon: number } } | undefined;
  const report = () => head && onProgress({ ...head, places: latest });
  primaryP.then((h) => { head = h; report(); }, () => {});

  const placesP = fetchLinkedPlaces(input, undefined, (so) => {
    const h = head;
    latest = h ? so.filter((p) => p.title !== h.title) : so;
    report();
  });
  // A missing page surfaces as NotFoundError from the primary query.
  const [{ title, primary }, places] = await Promise.all([primaryP, placesP]);

  const data: ArticleData = { title, primary, places: places.filter((p) => p.title !== title) };
  void bigCacheSet(key, data);
  if (title.toLowerCase() !== input.toLowerCase()) void bigCacheSet(`art:${title.toLowerCase()}`, data);
  return data;
}

// ---------------------------------------------------------------- summaries

const inflight = new Map<string, Promise<Summary>>();

/**
 * Fetches summaries for many places at once (20 per request, the most TextExtracts allows),
 * so hover cards for pins in view open fully formed instead of filling in. Fills the same
 * cache as getSummary. Requests run one after another to stay polite to Wikipedia.
 */
export async function prefetchSummaries(titles: string[]): Promise<void> {
  const todo = [...new Set(titles)].filter((t) => !cacheGet(`sum:${t}`) && !inflight.has(`sum:${t}`) && !batched.has(t));
  for (let i = 0; i < todo.length; i += 20) {
    const chunk = todo.slice(i, i + 20);
    chunk.forEach((t) => batched.add(t));
    try {
      const json = await actionQuery({
        action: 'query',
        prop: 'extracts|pageimages|description',
        exintro: '1',
        explaintext: '1',
        exchars: '500',
        exlimit: '20',
        piprop: 'thumbnail',
        pithumbsize: '200',
        titles: chunk.join('|'),
      });
      for (const p of json.query?.pages ?? []) {
        if (p.missing) continue;
        cacheSet(`sum:${p.title}`, {
          title: p.title,
          description: p.description,
          extract: p.extract ? cleanExtract(p.extract) : undefined,
          thumbnail: p.thumbnail,
        } satisfies Summary);
      }
    } catch {
      chunk.forEach((t) => batched.delete(t)); // try again next time
    }
  }
}
const batched = new Set<string>();

/**
 * TextExtracts keeps the pronunciation and foreign-name bracket that the REST summary drops:
 * "The Parthenon (; Ancient Greek: Παρθενών, …) is a former temple" -> "The Parthenon is a
 * former temple". Removes brackets in the first sentence that are empty, start with ";" or
 * hold a "Language: …" note.
 */
function cleanExtract(s: string): string {
  const firstStop = s.search(/[.!?](\s|$)/);
  const end = firstStop < 0 ? s.length : firstStop;
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '(' && i < end) {
      let depth = 0, j = i;
      for (; j < s.length; j++) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')' && --depth === 0) break;
      }
      const inner = s.slice(i + 1, j).trim();
      if (j < s.length && (!inner || inner.startsWith(';') || /^[^()]*?\b[A-Z][a-z]+( [A-Z][a-z]+)?:/.test(inner) || /pronounced|listen|IPA/i.test(inner))) {
        out = out.replace(/\s+$/, '');
        i = j + 1;
        continue;
      }
    }
    out += s[i++];
  }
  return out.replace(/\s+([,.;])/g, '$1').trim();
}

/** Page summary, fetched on demand and cached (memory + localStorage). */
export function getSummary(title: string): Promise<Summary> {
  const key = `sum:${title}`;
  const hit = cacheGet<Summary>(key);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(key);
  if (!p) {
    p = fetch(`${REST_API}/page/summary/${encodeURIComponent(toPageParam(title))}`)
      .then((r) => {
        if (!r.ok) throw new Error(`summary ${r.status}`);
        return r.json();
      })
      .then((j): Summary => {
        const s: Summary = {
          title: j.titles?.normalized ?? j.title ?? title,
          description: j.description,
          extract: j.extract,
          thumbnail: j.thumbnail,
        };
        cacheSet(key, s);
        return s;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}
