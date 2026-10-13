// Small DOM helpers for the AI panel: jump to a quoted passage in the open file, and
// outline a control for the "Show me" guide.

import { findQuote } from '../ai/text';

/**
 * Scrolls the open file's preview (text, markdown, code, docx, sheet) to a quoted passage and
 * marks it briefly with a CSS Custom Highlight. Returns false when the passage is not shown.
 */
export function revealText(quote: string): boolean {
  const root = document.querySelector('.fileview-body');
  if (!root) return false;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const starts: number[] = [];
  let all = '';
  while (walker.nextNode()) {
    const n = walker.currentNode as Text;
    starts.push(all.length);
    nodes.push(n);
    all += n.data;
  }
  const r = findQuote(all, quote);
  if (!r) return false;
  const at = (idx: number): [Text, number] => {
    let i = starts.length - 1;
    while (i > 0 && starts[i] > idx) i--;
    return [nodes[i], Math.min(idx - starts[i], nodes[i].data.length)];
  };
  const range = document.createRange();
  range.setStart(...at(r.start));
  range.setEnd(...at(r.end));
  range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (typeof Highlight !== 'undefined' && CSS.highlights) {
    CSS.highlights.set('ai-reveal', new Highlight(range));
    setTimeout(() => CSS.highlights.delete('ai-reveal'), 4000);
  }
  return true;
}

/** Briefly outlines the element matching `selector`. Returns false when it is not on screen. */
export function spotlight(selector: string): boolean {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return false;
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  el.classList.remove('spotlight');
  void el.offsetWidth; // restart the animation
  el.classList.add('spotlight');
  setTimeout(() => el.classList.remove('spotlight'), 2800);
  return true;
}
