/**
 * Desktop layout: draggable dividers for the place list's width and between the article
 * and the globe, and the collapsible place list. All remembered per browser (localStorage).
 */

const SPLIT_KEY = 'wg:layout:split';
const LIST_KEY = 'wg:layout:listCollapsed';
const LIST_W_KEY = 'wg:layout:listW';
const DEFAULT_LIST_W = 248;
const MIN_LIST_W = 180;
const MAX_LIST_W = 480;
const MIN_ARTICLE = 360;
const MIN_GLOBE = 320;
const DEFAULT_SPLIT = 0.5; // article share of the space right of the list
const KEY_STEP = 32;

const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string | null) => {
  try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ }
};

export function initLayout(onResize: () => void): void {
  const viewer = document.getElementById('viewer')!;
  const divider = document.getElementById('divider')!;
  const listDivider = document.getElementById('list-divider')!;
  const list = document.getElementById('list-pane')!;
  const toggle = document.getElementById('list-toggle') as HTMLButtonElement;

  // Stored as a fraction so it survives window resizes.
  let split = Number(read(SPLIT_KEY)) || DEFAULT_SPLIT;
  let listW = Number(read(LIST_W_KEY)) || DEFAULT_LIST_W;

  const available = () => viewer.clientWidth - list.offsetWidth - listDivider.offsetWidth - divider.offsetWidth;
  const apply = () => {
    if (matchMedia('(max-width: 820px)').matches) {
      viewer.style.removeProperty('--article-w');
      return;
    }
    // The list can't squeeze the article and globe below their minimums.
    const room = viewer.clientWidth - divider.offsetWidth - 9 - MIN_ARTICLE - MIN_GLOBE;
    const lw = Math.round(Math.max(MIN_LIST_W, Math.min(listW, MAX_LIST_W, room)));
    viewer.style.setProperty('--list-open-w', `${lw}px`);
    listDivider.setAttribute('aria-valuenow', String(lw));
    const avail = available();
    const w = Math.round(Math.min(Math.max(split * avail, MIN_ARTICLE), avail - MIN_GLOBE));
    viewer.style.setProperty('--article-w', `${Math.max(w, MIN_ARTICLE)}px`);
    divider.setAttribute('aria-valuenow', String(Math.round(split * 100)));
    onResize();
  };
  const setFromArticleWidth = (w: number) => {
    const avail = available();
    split = Math.min(Math.max(w, MIN_ARTICLE), avail - MIN_GLOBE) / avail;
    apply();
  };

  const setListW = (w: number) => {
    listW = Math.max(MIN_LIST_W, Math.min(w, MAX_LIST_W));
    apply();
  };
  listDivider.setAttribute('aria-valuemin', String(MIN_LIST_W));
  listDivider.setAttribute('aria-valuemax', String(MAX_LIST_W));
  listDivider.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    listDivider.setPointerCapture(e.pointerId);
    listDivider.classList.add('dragging');
    document.body.classList.add('resizing');
    const left = list.getBoundingClientRect().left;
    const move = (ev: PointerEvent) => setListW(ev.clientX - left - listDivider.offsetWidth / 2);
    const up = () => {
      listDivider.removeEventListener('pointermove', move);
      listDivider.classList.remove('dragging');
      document.body.classList.remove('resizing');
      write(LIST_W_KEY, String(listW));
    };
    listDivider.addEventListener('pointermove', move);
    listDivider.addEventListener('pointerup', up, { once: true });
    listDivider.addEventListener('pointercancel', up, { once: true });
  });
  listDivider.addEventListener('dblclick', () => {
    listW = DEFAULT_LIST_W;
    write(LIST_W_KEY, null);
    apply();
  });
  listDivider.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') setListW(list.offsetWidth - KEY_STEP);
    else if (e.key === 'ArrowRight') setListW(list.offsetWidth + KEY_STEP);
    else if (e.key === 'Home') setListW(MIN_LIST_W);
    else if (e.key === 'End') setListW(MAX_LIST_W);
    else return;
    e.preventDefault();
    write(LIST_W_KEY, String(listW));
  });

  divider.setAttribute('aria-valuemin', '0');
  divider.setAttribute('aria-valuemax', '100');

  divider.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    divider.setPointerCapture(e.pointerId);
    divider.classList.add('dragging');
    document.body.classList.add('resizing');
    const left = list.getBoundingClientRect().right;
    const move = (ev: PointerEvent) => setFromArticleWidth(ev.clientX - left - divider.offsetWidth / 2);
    const up = () => {
      divider.removeEventListener('pointermove', move);
      divider.classList.remove('dragging');
      document.body.classList.remove('resizing');
      write(SPLIT_KEY, String(split));
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', up, { once: true });
    divider.addEventListener('pointercancel', up, { once: true });
  });

  divider.addEventListener('dblclick', () => {
    split = DEFAULT_SPLIT;
    write(SPLIT_KEY, null);
    apply();
  });

  divider.addEventListener('keydown', (e) => {
    const cur = split * available();
    if (e.key === 'ArrowLeft') setFromArticleWidth(cur - KEY_STEP);
    else if (e.key === 'ArrowRight') setFromArticleWidth(cur + KEY_STEP);
    else if (e.key === 'Home') setFromArticleWidth(MIN_ARTICLE);
    else if (e.key === 'End') setFromArticleWidth(Infinity);
    else return;
    e.preventDefault();
    write(SPLIT_KEY, String(split));
  });

  const setCollapsed = (collapsed: boolean) => {
    viewer.classList.toggle('list-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.textContent = collapsed ? '»' : '«';
    toggle.title = collapsed ? 'Show the place list' : 'Hide the place list';
    write(LIST_KEY, collapsed ? '1' : null);
    apply();
  };
  toggle.addEventListener('click', () => setCollapsed(!viewer.classList.contains('list-collapsed')));
  setCollapsed(read(LIST_KEY) === '1');

  window.addEventListener('resize', apply);
  // The viewer is hidden on the landing page; re-apply once it has a size.
  new ResizeObserver(apply).observe(viewer);
}
