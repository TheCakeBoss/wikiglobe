/** Sentence lookups inside the rendered article (for snippets and "mentioned together"). */

/** Elements that hold running text. */
export const BLOCK = 'p, li, dd, blockquote';

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter('en', { granularity: 'sentence' })
  : null;

interface BlockText {
  text: string;
  /** Offset in `text` where each text node starts. */
  offsets: Map<Node, number>;
}

/** Text of a block without footnote markers, remembering where each text node sits. */
function blockText(block: Element): BlockText {
  let text = '';
  const offsets = new Map<Node, number>();
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest('.mw-ref, sup.reference, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  while (walker.nextNode()) {
    offsets.set(walker.currentNode, text.length);
    text += walker.currentNode.nodeValue;
  }
  return { text, offsets };
}

/** Offset of an element's first text within its block, or -1. */
function offsetOf(el: Element, bt: BlockText): number {
  for (const [node, off] of bt.offsets) if (el.contains(node)) return off;
  return -1;
}

/** [start, end) of the sentence covering `at`. */
function sentenceBounds(text: string, at: number): [number, number] {
  if (segmenter) {
    for (const seg of segmenter.segment(text)) {
      if (at >= seg.index && at < seg.index + seg.segment.length) return [seg.index, seg.index + seg.segment.length];
    }
  }
  return [0, text.length];
}

/** The sentence an element sits in, trimmed for display (long sentences are windowed). */
export function snippetAround(el: Element): string | undefined {
  const block = el.closest(BLOCK);
  if (!block) return undefined;
  const bt = blockText(block);
  const at = offsetOf(el, bt);
  if (at < 0) return undefined;
  const [start, end] = sentenceBounds(bt.text, at);
  let sentence = bt.text.slice(start, end);
  const elAt = at - start;
  if (sentence.length > 300) {
    // Keep the start if the element is near it, else window around it.
    const from = elAt < 200 ? 0 : elAt - 120;
    sentence = (from > 0 ? '…' : '') + sentence.slice(from, from + 280).trim() + '…';
  }
  return sentence.replace(/\s+/g, ' ').trim() || undefined;
}

/** Elements matching `selector` in the same sentence as `el`. */
export function sameSentence(el: Element, selector: string): Element[] {
  const block = el.closest(BLOCK);
  if (!block) return [];
  const bt = blockText(block);
  const at = offsetOf(el, bt);
  if (at < 0) return [];
  const [start, end] = sentenceBounds(bt.text, at);
  return [...block.querySelectorAll(selector)].filter((x) => {
    const o = offsetOf(x, bt);
    return o >= start && o < end;
  });
}
