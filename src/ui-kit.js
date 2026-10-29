// Kleine Bausteine der Oberfläche: DOM-Abfragen, HTML-Schutz, Achsenformat und Inline-SVG-Diagramme.
import { fmtNum } from './format.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/** Kurze Zahl für Achsen und Beschriftungen („653 Tsd.“, „1,2 Mio.“). */
export function short(v) {
  const a = Math.abs(v), sign = v < 0 ? '−' : '';
  if (a >= 1e6) return `${sign}${fmtNum(a / 1e6, a >= 1e7 ? 0 : 1)} Mio.`;
  if (a >= 1e3) return `${sign}${fmtNum(a / 1e3, 0)} Tsd.`;
  return `${sign}${fmtNum(a, 0)}`;
}

export function svgEl(name, attrs = {}, text) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text !== undefined) el.textContent = text;
  return el;
}
export function niceTicks(min, max, count = 5) {
  if (!(max > min)) { max = min + 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.floor(min / step) * step;
  const ticks = [];
  for (let v = start; ; v += step) {
    ticks.push(Math.round(v / step) * step);
    if (v >= max - step * 1e-9) break;
  }
  return ticks;
}
export function frame(container, minH = 240, top = 20) {
  const w = Math.max(280, Math.floor(container.clientWidth || 600));
  const h = Math.round(Math.min(380, Math.max(minH, w * 0.48)));
  const pad = { l: w < 480 ? 66 : 76, r: w < 480 ? 14 : 24, t: top, b: 36 };
  const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h, 'aria-hidden': 'true', focusable: 'false' });
  return { svg, w, h, pad, iw: w - pad.l - pad.r, ih: h - pad.t - pad.b };
}
export function legend(el, items) {
  el.innerHTML = items.map(({ cls, text }) => {
    const style = {
      'l-acc': 'stroke:var(--ink);stroke-width:2',
      'l-ink': 'stroke:var(--faint);stroke-width:2;stroke-dasharray:6 4',
      'l-acc2': 'stroke:var(--muted);stroke-width:1.5;stroke-dasharray:2 3',
      mark: 'stroke:var(--muted);stroke-width:1.5',
      'mark dash': 'stroke:var(--muted);stroke-width:1.5;stroke-dasharray:4 3',
    }[cls];
    const shape = cls === 'bar'
      ? '<rect x="0" y="2" width="28" height="10" rx="2" style="fill:var(--ink)"/>'
      : cls === 'bar prev'
      ? '<rect x="0.5" y="3.5" width="27" height="7" rx="2" style="fill:var(--sunken);stroke:var(--muted);stroke-width:1"/>'
      : `<line x1="0" y1="7" x2="28" y2="7" style="${style}"/>`;
    return `<li><svg width="28" height="14" aria-hidden="true">${shape}</svg><span>${esc(text)}</span></li>`;
  }).join('');
}
