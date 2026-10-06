// Brand hover effects, installed once for the whole app by event delegation (no per-component wiring):
//  - scramble decode: a primary button's label scrambles like a hash, then resolves left to right
//  - tilt plate: a token card leans toward the pointer, with a light sheen (.tcard.tilting::after in brand.css)
// Both are skipped under prefers-reduced-motion. Scramble edits the label's text nodes in place; if React rewrites a
// label mid-run (e.g. "Sending…"), the run adopts the new text instead of restoring a stale one.

const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#$%&*';
const SCRAMBLE_SEL = 'button.primary:not(:disabled), .btn.primary';
const TILT_SEL = '.tcard';

const running = new WeakSet<Element>();

function scramble(el: Element) {
  if (running.has(el)) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes: { n: Text; text: string; last: string }[] = [];
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const v = t.nodeValue ?? '';
    if (v.trim()) nodes.push({ n: t as Text, text: v, last: v });
  }
  if (!nodes.length) return;
  running.add(el);
  const frames = 14;
  let f = 0;
  const id = window.setInterval(() => {
    f++;
    for (const x of nodes) {
      if (x.n.nodeValue !== x.last) x.text = x.n.nodeValue ?? '';
      const done = Math.trunc((f / frames) * x.text.length);
      const next = f >= frames ? x.text : [...x.text].map((c, i) => (c === ' ' || i < done ? c : GLYPHS[(Math.random() * GLYPHS.length) | 0])).join('');
      x.n.nodeValue = next;
      x.last = next;
    }
    if (f >= frames) { window.clearInterval(id); running.delete(el); }
  }, 32);
}

let tilted: HTMLElement | null = null;
function untilt() {
  if (!tilted) return;
  tilted.style.transform = '';
  tilted.classList.remove('tilting');
  tilted = null;
}

export function installBrandFx() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.addEventListener('pointerover', (e) => {
    if ((e as PointerEvent).pointerType !== 'mouse') return;
    const btn = (e.target as Element | null)?.closest?.(SCRAMBLE_SEL);
    if (btn && !btn.contains(e.relatedTarget as Node | null)) scramble(btn);
  });
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const card = (e.target as Element | null)?.closest?.(TILT_SEL) as HTMLElement | null;
    if (card !== tilted) untilt();
    if (!card) return;
    const r = card.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    card.style.transform = `perspective(800px) rotateX(${((0.5 - py) * 9).toFixed(2)}deg) rotateY(${((px - 0.5) * 11).toFixed(2)}deg) translateY(-2px)`;
    card.style.setProperty('--sx', `${Math.round(px * 100)}%`);
    card.classList.add('tilting');
    tilted = card;
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', untilt);
  window.addEventListener('blur', untilt);
}
