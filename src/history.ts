import { toPageParam } from './wiki';

/**
 * Recently viewed articles, newest first, shown under the place list.
 * Kept per browser in localStorage.
 */
const KEY = 'wg:history';
const MAX = 50;

interface Entry {
  title: string;
  at: number; // ms since epoch
}

const load = (): Entry[] => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((e) => typeof e?.title === 'string' && typeof e?.at === 'number') : [];
  } catch {
    return [];
  }
};
const save = (entries: Entry[]) => {
  try { localStorage.setItem(KEY, JSON.stringify(entries)); } catch { /* ignore */ }
};

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
function ago(at: number): string {
  const s = (Date.now() - at) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  if (s < 86400 * 7) return rtf.format(-Math.round(s / 86400), 'day');
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export class PageHistory {
  private entries = load();
  private current: string | null = null;
  private section = document.getElementById('history')!;
  private list = document.getElementById('history-list')!;

  constructor() {
    document.getElementById('history-clear')!.addEventListener('click', () => {
      this.entries = [];
      save(this.entries);
      this.render();
    });
    // Keep "5 min ago" roughly current.
    setInterval(() => { if (!this.section.hidden) this.render(); }, 60_000);
    this.render();
  }

  /** Records a visit (moves the article to the top) and marks it as the current one. */
  visit(title: string) {
    this.current = title;
    this.entries = [{ title, at: Date.now() }, ...this.entries.filter((e) => e.title !== title)].slice(0, MAX);
    save(this.entries);
    this.render();
  }

  private render() {
    this.section.hidden = this.entries.length === 0;
    this.list.replaceChildren(...this.entries.map((e) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `?page=${encodeURIComponent(toPageParam(e.title))}`;
      if (e.title === this.current) a.setAttribute('aria-current', 'page');
      const t = document.createElement('span');
      t.className = 'history-title';
      t.textContent = e.title;
      t.title = e.title;
      const time = document.createElement('time');
      time.className = 'history-time';
      time.dateTime = new Date(e.at).toISOString();
      time.textContent = ago(e.at);
      a.append(t, time);
      li.append(a);
      return li;
    }));
  }
}
