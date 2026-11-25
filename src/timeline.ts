import { NON_PROSE } from './article';
import { snippetAround } from './sentence';

/** How many of the most-mentioned years get a pin. */
export const TIMELINE_YEARS = 15;

export interface YearInfo {
  year: number; // negative = BC
  count: number;
  /** The year's mentions in the article, in reading order. */
  spans: HTMLElement[];
}

export const yearLabel = (y: number) => (y < 0 ? `${-y} BC` : String(y));

// A standalone number, optionally with an era: "1915", "200 BC", "AD 79", "1914–1918".
const YEAR_RE = /(?<![\p{L}\p{N},.$£€#])(?:(AD|CE)\s+)?(\d{1,4})(?:\s*(BCE|BC|AD|CE)\b)?(?![\p{N}]|[.,]\d|\s?%|s\b|st\b|nd\b|rd\b|th\b|')/gu;
// Numbers followed by these are quantities, not years ("1500 troops").
const UNIT_RE = /^\s*(km|kilomet|metres?|meters?|m\b|mi\b|miles|ft\b|feet|kg|tonnes|tons|hectares|acres|sq|people|men|soldiers|troops|casualties|copies|units|vehicles|ships|aircraft)/i;
const SKIP = `${NON_PROSE}, .infobox, .hatnote, .dablink, table, figure, h2, h3, h4, h5, h6, .yr`;

/**
 * Finds years in the article's running text, wraps each mention in
 * `<span class="yr" data-year>`, and returns them by year.
 */
export function indexYears(root: HTMLElement): Map<number, YearInfo> {
  const maxYear = new Date().getFullYear() + 1;
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

  const years = new Map<number, YearInfo>();
  for (const node of nodes) {
    const text = node.nodeValue!;
    const hits: { start: number; end: number; year: number }[] = [];
    for (const m of text.matchAll(YEAR_RE)) {
      const [whole, pre, num, post] = m;
      const n = Number(num);
      const era = (pre ?? post)?.toUpperCase();
      let year: number;
      if (era === 'BC' || era === 'BCE') year = -n;
      else if (era) year = n;
      else if (num.length === 4 && n >= 1000 && n <= maxYear) year = n;
      else continue;
      if (n === 0 || UNIT_RE.test(text.slice(m.index! + whole.length))) continue;
      hits.push({ start: m.index!, end: m.index! + whole.length, year });
    }
    // Wrap from the end so earlier offsets stay valid.
    for (const h of hits.reverse()) {
      const mid = node.splitText(h.start);
      mid.splitText(h.end - h.start);
      const span = document.createElement('span');
      span.className = 'yr';
      span.dataset.year = String(h.year);
      mid.replaceWith(span);
      span.append(mid);
      const info = years.get(h.year) ?? { year: h.year, count: 0, spans: [] };
      info.count++;
      info.spans.unshift(span); // hits are reversed within a node
      years.set(h.year, info);
    }
  }
  // Restore reading order across nodes (unshift above only fixes order within one node).
  for (const info of years.values()) {
    info.spans.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }
  return years;
}

/** The most-mentioned years (earliest first mention breaks ties), in chronological order. */
export function topYears(all: Map<number, YearInfo>, n = TIMELINE_YEARS): YearInfo[] {
  return [...all.values()]
    .sort((a, b) => b.count - a.count ||
      (a.spans[0].compareDocumentPosition(b.spans[0]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    .slice(0, n)
    .sort((a, b) => a.year - b.year);
}

export interface TimelineOptions {
  onHover: (year: number | null) => void;
  onSelect: (year: number) => void;
}

/** The strip under the globe: one pin per year, spaced on a compressed scale. */
export class Timeline {
  private years: YearInfo[] = [];
  private pins = new Map<number, HTMLButtonElement>();
  private card: HTMLDivElement;
  private track: HTMLDivElement;

  constructor(private el: HTMLElement, private opts: TimelineOptions) {
    this.track = document.createElement('div');
    this.track.className = 'tl-track';
    this.card = document.createElement('div');
    this.card.className = 'tl-card';
    this.card.hidden = true;
    el.append(this.track, this.card);
    new ResizeObserver(() => this.layoutLabels()).observe(el);
  }

  render(years: YearInfo[]) {
    this.years = years;
    this.pins.clear();
    this.track.replaceChildren();
    this.card.hidden = true;
    this.el.hidden = years.length < 2;
    if (this.el.hidden) return;

    const xs = positions(years.map((y) => y.year));
    const max = Math.max(...years.map((y) => y.count));
    this.track.append(Object.assign(document.createElement('div'), { className: 'tl-axis' }));

    // Mark compressed stretches with a break so the spacing isn't read literally.
    for (let i = 1; i < years.length; i++) {
      const gap = years[i].year - years[i - 1].year;
      if (gap > 60 && gap > (years.at(-1)!.year - years[0].year) / 6) {
        const b = document.createElement('div');
        b.className = 'tl-break';
        b.style.left = `${(xs[i - 1] + xs[i]) / 2}%`;
        b.title = `${gap} years`;
        this.track.append(b);
      }
    }

    years.forEach((y, i) => {
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'tl-pin';
      pin.style.left = `${xs[i]}%`;
      const size = 8 + 12 * Math.sqrt(y.count / max);
      pin.style.setProperty('--size', `${size}px`);
      pin.style.setProperty('--strength', String(0.45 + 0.55 * (y.count / max)));
      pin.setAttribute('aria-label', `${yearLabel(y.year)}, mentioned ${y.count} time${y.count === 1 ? '' : 's'}`);
      const dot = document.createElement('span');
      dot.className = 'tl-dot';
      const label = document.createElement('span');
      label.className = 'tl-label';
      label.textContent = yearLabel(y.year);
      pin.append(dot, label);
      const enter = () => { this.highlight(y.year); this.opts.onHover(y.year); };
      const leave = () => { this.highlight(null); this.opts.onHover(null); };
      pin.addEventListener('mouseenter', enter);
      pin.addEventListener('mouseleave', leave);
      pin.addEventListener('focus', enter);
      pin.addEventListener('blur', leave);
      pin.addEventListener('click', () => this.opts.onSelect(y.year));
      this.pins.set(y.year, pin);
      this.track.append(pin);
    });
    this.layoutLabels();
  }

  /** Marks the selected year's pin (it stays marked until cleared). */
  setSelected(year: number | null) {
    for (const [y, pin] of this.pins) pin.classList.toggle('sel', y === year);
  }

  /** Highlights a year's pin and shows its card. `withCard` false just marks the pin. */
  highlight(year: number | null, withCard = true) {
    for (const [y, pin] of this.pins) pin.classList.toggle('hl', y === year);
    const info = year === null ? undefined : this.years.find((y) => y.year === year);
    if (!info || !withCard) {
      this.card.hidden = true;
      return;
    }
    const pin = this.pins.get(info.year)!;
    this.card.replaceChildren();
    const h = document.createElement('h3');
    h.textContent = yearLabel(info.year);
    const meta = document.createElement('span');
    meta.className = 'tl-count';
    meta.textContent = ` · ${info.count} mention${info.count === 1 ? '' : 's'}`;
    h.append(meta);
    this.card.append(h);
    const s = snippetAround(info.spans[0]);
    if (s) this.card.append(Object.assign(document.createElement('p'), { className: 'card-snippet', textContent: s }));
    this.card.append(Object.assign(document.createElement('p'), { className: 'card-hint', textContent: 'Click to jump to it in the article' }));
    this.card.hidden = false;
    // Keep the card inside the strip horizontally.
    const trackW = this.el.clientWidth;
    const cardW = this.card.offsetWidth;
    const x = pin.offsetLeft + this.track.offsetLeft;
    this.card.style.left = `${Math.min(Math.max(x - cardW / 2, 8), trackW - cardW - 8)}px`;
  }

  /** Hides labels that would overlap, keeping the most-mentioned years. */
  private layoutLabels() {
    const placed: [number, number][] = [];
    const order = [...this.years].sort((a, b) => b.count - a.count);
    for (const y of order) {
      const label = this.pins.get(y.year)?.querySelector<HTMLElement>('.tl-label');
      if (!label) continue;
      label.style.visibility = 'visible';
      const r = label.getBoundingClientRect();
      if (placed.some(([l, rr]) => r.left < rr + 6 && r.right > l - 6)) label.style.visibility = 'hidden';
      else placed.push([r.left, r.right]);
    }
  }
}

/**
 * x positions (0..100) for sorted years. Gaps are compressed with a log so a span like
 * 200 BC .. 2010 doesn't squash the busy decades into one corner.
 */
function positions(years: number[]): number[] {
  if (years.length === 1) return [50];
  const steps = years.slice(1).map((y, i) => Math.log2(1 + (y - years[i])));
  const total = steps.reduce((a, b) => a + b, 0) || 1;
  const xs = [0];
  for (const s of steps) xs.push(xs.at(-1)! + (s / total) * 100);
  return xs;
}
