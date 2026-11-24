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
