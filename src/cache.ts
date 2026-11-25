import { CACHE_PREFIX, CACHE_TTL_MS } from './config';

const memory = new Map<string, unknown>();

interface Stored<T> {
  t: number;
  v: T;
}

/** In-memory first, then localStorage (24h expiry). Storage failures are ignored. */
export function cacheGet<T>(key: string, persistent = true): T | undefined {
  if (memory.has(key)) return memory.get(key) as T;
  if (!persistent) return undefined;
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return undefined;
    const entry = JSON.parse(raw) as Stored<T>;
    if (Date.now() - entry.t > CACHE_TTL_MS) {
      localStorage.removeItem(CACHE_PREFIX + key);
      return undefined;
    }
    memory.set(key, entry.v);
    return entry.v;
  } catch {
    return undefined;
  }
}

export function cacheSet<T>(key: string, value: T, persistent = true): void {
  memory.set(key, value);
  if (!persistent) return;
  const payload = JSON.stringify({ t: Date.now(), v: value } satisfies Stored<T>);
  try {
    localStorage.setItem(CACHE_PREFIX + key, payload);
  } catch {
    // Quota exceeded: drop expired/oldest entries once and retry.
    try {
      evictOldest();
      localStorage.setItem(CACHE_PREFIX + key, payload);
    } catch {
      /* give up; the memory cache still holds it */
    }
  }
}

function evictOldest(): void {
  const entries: { key: string; t: number }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(CACHE_PREFIX)) continue;
    try {
      entries.push({ key, t: (JSON.parse(localStorage.getItem(key)!) as Stored<unknown>).t });
    } catch {
      entries.push({ key, t: 0 });
    }
  }
  entries.sort((a, b) => a.t - b.t);
  for (const e of entries.slice(0, Math.max(1, Math.ceil(entries.length / 2)))) {
    localStorage.removeItem(e.key);
  }
}

// ---------------------------------------------------------------- large entries

/**
 * Article HTML and place lists are too big for localStorage (5 MB holds ~7 articles), so
 * they go to IndexedDB, gzip-compressed (about 5x smaller), up to MAX_ENTRIES of them.
 * Falls back to the memory cache alone where IndexedDB or compression isn't available
 * (some private-browsing modes).
 */
const DB_NAME = 'wikipedia-globe';
const STORE = 'cache';
const MAX_ENTRIES = 600; // ~300 articles (HTML + places), roughly 50 MB compressed

interface BigEntry {
  k: string;
  t: number;
  z: Blob; // gzip-compressed JSON
}

/** Large entries kept in memory too, oldest first; capped so a long session stays lean. */
const bigInMemory: string[] = [];
const MAX_IN_MEMORY = 30;
function rememberBig(key: string, value: unknown) {
  memory.set(key, value);
  const i = bigInMemory.indexOf(key);
  if (i >= 0) bigInMemory.splice(i, 1);
  bigInMemory.push(key);
  while (bigInMemory.length > MAX_IN_MEMORY) memory.delete(bigInMemory.shift()!);
}

let dbPromise: Promise<IDBDatabase> | undefined;
function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    if (!('indexedDB' in window) || typeof CompressionStream === 'undefined') {
      reject(new Error('no IndexedDB/CompressionStream'));
      return;
    }
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'k' }).createIndex('t', 't');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbPromise;
}

const done = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const gzip = (s: string) =>
  new Response(new Blob([s]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
const gunzip = (b: Blob) =>
  new Response(b.stream().pipeThrough(new DecompressionStream('gzip'))).text();

/** Memory first, then IndexedDB (same 24h expiry as the small cache). */
export async function bigCacheGet<T>(key: string): Promise<T | undefined> {
  if (memory.has(key)) return memory.get(key) as T;
  try {
    const db = await openDb();
    const e = await done<BigEntry | undefined>(db.transaction(STORE).objectStore(STORE).get(key));
    if (!e) return undefined;
    if (Date.now() - e.t > CACHE_TTL_MS) {
      db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key);
      return undefined;
    }
    const v = JSON.parse(await gunzip(e.z)) as T;
    rememberBig(key, v);
    return v;
  } catch {
    return undefined;
  }
}

export async function bigCacheSet<T>(key: string, value: T): Promise<void> {
  rememberBig(key, value);
  try {
    const db = await openDb();
    const z = await gzip(JSON.stringify(value));
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.put({ k: key, t: Date.now(), z } satisfies BigEntry);
    // Keep the newest MAX_ENTRIES: walk the oldest first and delete the excess.
    const count = await done(store.count());
    let excess = count - MAX_ENTRIES;
    if (excess > 0) {
      const cursorReq = store.index('t').openCursor();
      cursorReq.onsuccess = () => {
        const c = cursorReq.result;
        if (!c || excess-- <= 0) return;
        c.delete();
        c.continue();
      };
    }
  } catch {
    /* storage unavailable or full; the memory cache still holds it */
  }
}

/** One-off: article entries written to localStorage by earlier versions. */
try {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith(`${CACHE_PREFIX}html`) || k.startsWith(`${CACHE_PREFIX}art:`)) localStorage.removeItem(k);
  }
} catch {
  /* ignore */
}
