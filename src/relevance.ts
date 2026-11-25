import { NON_PROSE } from './article';
import { BLOCK, snippetAround } from './sentence';
import type { Place } from './wiki';

/** Weights for the relevance score. */
const W = {
  link: 1, // per link in the article body (prose, lists, infobox)
  lead: 3, // linked in the lead section
  infobox: 2, // linked in the infobox
  main: 2, // a section's "Main article:" hatnote points at it
  mention: 0.5, // per plain-text mention of the place's name, capped
  mentionCap: 10,
};

export interface ScoredPlace extends Place {
  score: number;
  links: number;
  lead: boolean;
  infobox: boolean;
  main: boolean;
  mentions: number;
  /** Sentence around the first prose link. */
  snippet?: string;
}

interface LinkInfo {
  anchors: HTMLAnchorElement[];
  lead: boolean;
  infobox: boolean;
  main: boolean;
}

/** Disambiguation hatnotes at the top ("X redirects here...") say nothing about relevance. */
const LEAD_HATNOTE = 'section[data-mw-section-id="0"] .hatnote, section[data-mw-section-id="0"] .dablink';

/** Normalises a title the way MediaWiki does for matching (spaces, first letter upper-case). */
const norm = (t: string) => {
  const s = t.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/**
 * Indexes the rendered article. Counts only links in the body: reference lists, the
 * lead's disambiguation hatnotes, sidebars and trailing sections ("See also", ...) are ignored.
 */
export class ArticleIndex {
  private byTitle = new Map<string, LinkInfo>();
  private proseText: string;
  /** proseText lower-cased once, for fast mention counting. */
  private proseLower: string;
  /** Per-place results, reused when scoring again (each batch of places, each slider move). */
  private cache = new Map<string, Omit<ScoredPlace, keyof Place> | null>();

  constructor(root: HTMLElement) {
    for (const a of root.querySelectorAll<HTMLAnchorElement>('a.wl[data-title]')) {
      if (a.closest(NON_PROSE) || a.closest(LEAD_HATNOTE)) continue;
      const key = norm(a.dataset.title!);
      const info = this.byTitle.get(key) ?? { anchors: [], lead: false, infobox: false, main: false };
      const inInfobox = !!a.closest('.infobox');
      const inHatnote = !!a.closest('.hatnote, .dablink');
      info.anchors.push(a);
      info.infobox ||= inInfobox;
      info.main ||= inHatnote;
      info.lead ||= !inInfobox && !inHatnote && !!a.closest('section[data-mw-section-id="0"]');
      this.byTitle.set(key, info);
    }
    this.proseText = proseTextOf(root);
    this.proseLower = this.proseText.toLowerCase();
  }

  /**
   * Scores places by how prominently the article uses them. Places only linked from
   * references, navboxes or "See also" score 0 and are returned separately.
   */
  score(places: Place[]): { ranked: ScoredPlace[]; unlinked: Place[] } {
    const ranked: ScoredPlace[] = [];
    const unlinked: Place[] = [];
    for (const p of places) {
      let s = this.cache.get(p.title);
      if (s === undefined) {
        s = this.scoreOne(p);
        this.cache.set(p.title, s);
      }
      if (s) ranked.push(withLazySnippet({ ...p, ...s }, s));
      else unlinked.push(p);
    }
    ranked.sort((a, b) => b.score - a.score || b.mentions - a.mentions || a.title.localeCompare(b.title));
    return { ranked, unlinked };
  }

  private scoreOne(p: Place): Omit<ScoredPlace, keyof Place> | null {
    const info = this.infoFor(p);
    if (!info) return null;
    let mentions = 0;
    for (const t of [p.title, ...(p.aliases ?? [])]) {
      mentions = Math.max(mentions, countMentions(this.proseText, this.proseLower, t));
    }
    const score =
      info.anchors.length * W.link +
      (info.lead ? W.lead : 0) +
      (info.infobox ? W.infobox : 0) +
      (info.main ? W.main : 0) +
      Math.min(mentions, W.mentionCap) * W.mention;
    // Tag every link to this place so the UI can find its mentions.
    for (const a of info.anchors) a.dataset.place = p.title;
    // The snippet (sentence splitting is the slow part) is worked out only when first read,
    // which for most places is never: only pinned places show it.
    let snippet: string | undefined | null = null;
    const result: Omit<ScoredPlace, keyof Place> = {
      score, links: info.anchors.length, lead: info.lead, infobox: info.infobox, main: info.main, mentions,
    };
    // Not enumerable here, so spreading `result` doesn't evaluate it; withLazySnippet re-exposes it.
    Object.defineProperty(result, 'snippet', {
      get: () => (snippet === null ? (snippet = snippetFor(info.anchors)) : snippet),
      enumerable: false,
    });
    return result;
  }

  /**
   * Where to scroll for a place: the running-text link its context snippet quotes,
   * else its first link in reading order (e.g. in the infobox).
   */
  firstMention(p: Place): HTMLAnchorElement | undefined {
    const anchors = this.infoFor(p)?.anchors;
    return anchors && (proseAnchor(anchors) ?? anchors[0]);
  }

  private infoFor(p: Place): LinkInfo | undefined {
    const keys = [p.title, ...(p.aliases ?? [])].map(norm);
    const infos = keys.map((k) => this.byTitle.get(k)).filter((x): x is LinkInfo => !!x);
    if (infos.length <= 1) return infos[0];
    // Linked under several redirect titles: merge, keeping document order.
    const anchors = infos.flatMap((i) => i.anchors);
    anchors.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    return {
      anchors,
      lead: infos.some((i) => i.lead),
      infobox: infos.some((i) => i.infobox),
      main: infos.some((i) => i.main),
    };
  }
}

// ------------------------------------------------------------------ text helpers

/** Text of the article body, skipping references, infobox and other non-prose parts. */
function proseTextOf(root: HTMLElement): string {
  const parts: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest(`${NON_PROSE}, .infobox, .hatnote, .dablink, figure, table`) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  while (walker.nextNode()) parts.push(walker.currentNode.nodeValue!);
  return parts.join('');
}

/** Name as it appears in running text: "Dartmouth, Devon" -> "Dartmouth", "Troy (city)" -> "Troy". */
function plainName(title: string): string {
  return title.replace(/\s*\(.*\)$/, '').split(',')[0].trim();
}

/** Copies the snippet getter onto a spread copy (spreading reads it, which defeats the laziness). */
function withLazySnippet<T extends object>(target: T, source: { snippet?: string }): T {
  Object.defineProperty(target, 'snippet', { get: () => source.snippet, enumerable: true, configurable: true });
  return target;
}

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/**
 * Whole-word mentions of a place's name. First letter exact (so "nice" isn't Nice), the rest
 * case-insensitive ("ANZAC Cove" = "Anzac Cove"). Searches the lower-cased text with indexOf,
 * which is several times faster than a Unicode-aware regex per place.
 */
function countMentions(text: string, lower: string, title: string): number {
  const name = plainName(title);
  if (name.length < 4) return 0; // too ambiguous
  const needle = name.toLowerCase();
  // Lower-casing changed some lengths (rare letters like "İ"): offsets no longer line up.
  if (needle.length !== name.length || lower.length !== text.length) return countMentionsRegex(text, name);
  let n = 0;
  for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, i + 1)) {
    if (text[i] === name[0] && !isWordChar(text[i - 1]) && !isWordChar(text[i + needle.length])) n++;
  }
  return n;
}

const mentionCache = new Map<string, RegExp>();
function countMentionsRegex(text: string, name: string): number {
  let re = mentionCache.get(name);
  if (!re) {
    // First letter exact (so "nice" isn't Nice), the rest case-insensitive ("ANZAC Cove" = "Anzac Cove").
    const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const body = [...name].map((c, i) =>
      i > 0 && c.toLowerCase() !== c.toUpperCase() ? `[${c.toLowerCase()}${c.toUpperCase()}]` : esc(c)).join('');
    re = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'gu');
    mentionCache.set(name, re);
  }
  return text.match(re)?.length ?? 0;
}

/** First link in running text (not the infobox, a hatnote, a table or a caption). */
function proseAnchor(anchors: HTMLAnchorElement[]): HTMLAnchorElement | undefined {
  return anchors.find((x) => !x.closest('.infobox, .hatnote, table, figure') && x.closest(BLOCK));
}

/** The sentence containing the first link that sits in running text. */
function snippetFor(anchors: HTMLAnchorElement[]): string | undefined {
  const a = proseAnchor(anchors);
  return a && snippetAround(a);
}
