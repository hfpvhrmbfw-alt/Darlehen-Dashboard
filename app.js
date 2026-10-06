// Oberfläche, Zustand und Diagramme des Darlehen-Trackers.
import {
  DEFAULTS as CALC_DEFAULTS, TARGET,
  compare, milestones, validate, pick, toModel,
  currentMonth, monthDiff, addMonths, repaymentPlan, buildCustomPlan,
  fmtNum, fmtEur, fmtPct, fmtYears,
} from './calc.js';
import { fetchQuote, searchSymbols, PUBLIC_PROXY_NAME } from './quote.js';

// Eingaben der App: Rechenkern plus Kursabruf (Symbol und Anteile)
const DEFAULTS = Object.freeze({ ...CALC_DEFAULTS, etfSymbol: '', etfShares: 0, loanShares: 0 });
const TEXT_KEYS = ['variant', 'planMode', 'planStart', 'planCustom', 'etfSymbol'];

const STORE_KEY = 'darlehen-tracker:v1';
const RATES = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const NUM_KEYS = Object.keys(DEFAULTS).filter((k) => !TEXT_KEYS.includes(k));
const SVG_NS = 'http://www.w3.org/2000/svg';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---------- Speicher (localStorage mit try/catch) ----------

function storeGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function storeSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

function sanitize(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of NUM_KEYS) {
    if (k in raw) {
      const v = typeof raw[k] === 'string' ? Number(raw[k].replace(',', '.')) : Number(raw[k]);
      if (Number.isFinite(v)) out[k] = v;
    }
  }
  if (raw.variant === 'A' || raw.variant === 'B') out.variant = raw.variant;
  if (['standard', 'simple', 'custom'].includes(raw.planMode)) out.planMode = raw.planMode;
  if (typeof raw.planStart === 'string' && (raw.planStart === '' || /^\d{4}-\d{2}$/.test(raw.planStart))) out.planStart = raw.planStart;
  if (Array.isArray(raw.planCustom)) {
    out.planCustom = raw.planCustom
      .filter((r) => r && /^\d{4}-\d{2}$/.test(String(r.m)) && Number.isFinite(Number(r.a)))
      .slice(0, 1200)
      .map((r) => ({ m: String(r.m), a: Math.max(0, Number(r.a)) }));
  }
  if (typeof raw.etfSymbol === 'string') out.etfSymbol = raw.etfSymbol.slice(0, 60);
  return out;
}
/** Eingaben für den Rechenkern, mit heutigem Monat als Bezugspunkt. */
function inp(extra = {}) { return { ...state.input, refMonth: currentMonth(), ...extra }; }
function fmtMonth(ym) {
  if (!ym) return '–';
  const [y, mo] = ym.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString('de-DE', { month: 'short', year: 'numeric' });
}

const saved = storeGet(STORE_KEY) || {};
const state = {
  input: sanitize(saved.input),
  view: { net: !!(saved.view && saved.view.net), real: !!(saved.view && saved.view.real) },
  tab: Number(saved.tab) >= 1 && Number(saved.tab) <= 8 ? Number(saved.tab) : 1,
  theme: ['auto', 'light', 'dark'].includes(saved.theme) ? saved.theme : 'auto',
  settings: {
    proxy: saved.settings && typeof saved.settings.proxy === 'string' ? saved.settings.proxy : '',
    allowPublic: saved.settings ? saved.settings.allowPublic !== false : true,
  },
  quote: saved.quote && Number.isFinite(saved.quote.price) ? saved.quote : null,
};
function persist() {
  storeSet(STORE_KEY, { input: state.input, view: state.view, tab: state.tab, theme: state.theme, settings: state.settings, quote: state.quote });
}

// ---------- Format-Helfer ----------

function short(v) {
  const a = Math.abs(v), sign = v < 0 ? '−' : '';
  if (a >= 1e6) return `${sign}${fmtNum(a / 1e6, a >= 1e7 ? 0 : 1)} Mio.`;
  if (a >= 1e3) return `${sign}${fmtNum(a / 1e3, 0)} Tsd.`;
  return `${sign}${fmtNum(a, 0)}`;
}
function signedEur(v) { return `${v > 0 ? '+' : ''}${fmtEur(v)}`; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function viewLabel(v = state.view) { return `${v.net ? 'netto' : 'brutto'}, ${v.real ? 'real (Kaufkraft heute)' : 'nominal'}`; }

// ---------- Theme ----------

const THEME_TEXT = { auto: 'Auto', light: 'Hell', dark: 'Dunkel' };
function applyTheme() {
  const root = document.documentElement;
  if (state.theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', state.theme);
  const btn = $('#theme-toggle');
  btn.textContent = `Farbe: ${THEME_TEXT[state.theme]}`;
  btn.setAttribute('aria-label', `Farbschema: ${THEME_TEXT[state.theme]}. Klicken zum Wechseln.`);
  const metas = $$('meta[name="theme-color"]');
  metas.forEach((m) => {
    const sys = m.media.includes('dark') ? '#1D1916' : '#E3DAD3';
    m.content = state.theme === 'auto' ? sys : state.theme === 'dark' ? '#1D1916' : '#E3DAD3';
  });
}
$('#theme-toggle').addEventListener('click', () => {
  state.theme = state.theme === 'auto' ? 'light' : state.theme === 'light' ? 'dark' : 'auto';
  applyTheme(); persist(); renderCharts();
});

// ---------- Tabs (ARIA, Pfeiltasten) ----------

const tabs = $$('[role="tab"]');
function selectTab(n, focus = false) {
  state.tab = n;
  tabs.forEach((t, i) => {
    const on = i + 1 === n;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $('#' + t.getAttribute('aria-controls')).hidden = !on;
    if (on && focus) t.focus();
  });
  persist();
  renderCharts();
}
tabs.forEach((t, i) => {
  t.addEventListener('click', () => selectTab(i + 1));
  t.addEventListener('keydown', (e) => {
    let n = null;
    if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = tabs.length - 1;
    if (n !== null) { e.preventDefault(); selectTab(n + 1, true); }
  });
});

// ---------- Ansicht brutto/netto, nominal/real ----------

$$('[data-view]').forEach((b) => b.addEventListener('click', () => {
  state.view[b.dataset.view] = b.dataset.value === '1';
  persist(); syncView(); renderDeterministic();
}));
function syncView() {
  $$('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(state.view[b.dataset.view] === (b.dataset.value === '1'))));
  $('#view-desc').textContent = `Werte in № 02 und № 04: ${viewLabel()}.`;
}

// ---------- Formular ----------

const form = $('#form');
form.addEventListener('submit', (e) => e.preventDefault());

function fmtField(key, v) {
  if (['cryptoGrowth', 'etfReturn', 'loanRate', 'volatility'].includes(key)) return `${fmtNum(v, 1)} %`;
  if (['crypto', 'etf', 'savings', 'loan', 'loanEtfNow'].includes(key)) return fmtEur(v);
  if (key === 'grace') return `${fmtNum(v, 0)} J.`;
  return fmtNum(v, 0);
}
function syncForm() {
  for (const field of $$('.field[data-key]', form)) {
    const key = field.dataset.key;
    const v = state.input[key];
    if (field.dataset.kind === 'radio') {
      $$('input[type="radio"]', field).forEach((r) => { r.checked = r.value === v; });
      continue;
    }
    const el = $(`[name="${key}"]`, field);
    if (el && document.activeElement !== el) el.value = String(v);
    if (field.dataset.kind === 'select' && el) {
      if (![...el.options].some((o) => o.value === String(v))) {
        const o = document.createElement('option'); o.value = String(v); o.textContent = `${fmtNum(v, 1)} Jahre`; el.append(o);
      }
      el.value = String(v);
    }
    const out = $(`[data-out="${key}"]`, field);
    if (out) out.textContent = fmtField(key, v);
    if (el && el.type === 'range') el.setAttribute('aria-valuetext', fmtField(key, v));
  }
  const m = toModel(inp());
  const std = state.input.planMode === 'standard';
  ['grace', 'term'].forEach((k) => { const el = $(`[name="${k}"]`, form); if (el) el.disabled = !std; });
  $('#plan-hint').textContent = std ? 'Rückzahlung: Standard-Plan (unten). Eigenen Plan in № 03 festlegen.' : `Rückzahlung: ${state.input.planMode === 'simple' ? 'einfacher' : 'individueller'} Plan aus № 03; die beiden Felder unten gelten dann nicht.`;
  if (document.activeElement !== $('#in-etfSymbol')) $('#in-etfSymbol').value = state.input.etfSymbol;
  ['etfShares', 'loanShares'].forEach((k) => { const el = $(`#in-${k}`); if (document.activeElement !== el) el.value = String(state.input[k]); });
  $('#in-proxy').value = state.settings.proxy;
  $('#in-allowPublic').checked = state.settings.allowPublic;
  syncPlanForm();
  $('#horizon-out').textContent = `Bis Alter ${fmtNum(state.input.ageTarget, 0)}, das sind ${m.horizonYears} Jahre ab heute.`;
}
form.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.name) return;
  if (el.name === 'variant') state.input.variant = el.value;
  else if (el.name === 'etfSymbol') { state.input.etfSymbol = el.value.trim(); persist(); return; }
  else {
    if (el.value === '') return; // halb getippte Zahl nicht übernehmen
    const v = Number(el.value);
    state.input[el.name] = Number.isFinite(v) ? v : el.value;
    if ((el.name === 'etfShares' || el.name === 'loanShares') && state.quote) applyQuote(false);
  }
  persist(); syncForm(); update();
});
form.addEventListener('change', (e) => {
  if (e.target.value === '' && e.target.name && !['variant', 'etfSymbol'].includes(e.target.name)) { e.target.value = String(state.input[e.target.name]); }
});
$$('[data-loan]').forEach((b) => b.addEventListener('click', () => { state.input.loan = Number(b.dataset.loan); persist(); syncForm(); update(); }));
$$('[data-preset]').forEach((b) => b.addEventListener('click', () => {
  const [loan, term] = b.dataset.preset.split('-').map(Number);
  state.input.loan = loan; state.input.term = term;
  persist(); syncForm(); update();
  setIo(`Schnellwahl übernommen: ${fmtEur(loan)}, Tilgung über ${term} Jahre.`);
}));

let ioTimer;
function setIo(text) {
  const el = $('#io-status'); el.textContent = text;
  clearTimeout(ioTimer); ioTimer = setTimeout(() => { el.textContent = ''; }, 6000);
}
$('#btn-reset').addEventListener('click', () => {
  state.input = { ...DEFAULTS };
  persist(); syncForm(); renderPlanEditor(); update(); setIo('Alle Eingaben auf die Ausgangswerte zurückgesetzt.');
});
$('#btn-export').addEventListener('click', () => {
  const data = { app: 'darlehen-tracker', version: 1, exportiert: new Date().toISOString(), eingaben: state.input };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `darlehen-tracker-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setIo('Eingaben als JSON exportiert.');
});
$('#btn-import').addEventListener('click', () => $('#file-import').click());
$('#file-import').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const raw = data && typeof data === 'object' ? (data.eingaben || data.input || data) : null;
    if (!raw || !Object.keys(raw).some((k) => k in DEFAULTS)) throw new Error('keine bekannten Felder');
    state.input = sanitize(raw);
    persist(); syncForm(); renderPlanEditor(); update();
    setIo(`JSON importiert: ${file.name}.`);
  } catch (err) {
    setIo(`Import fehlgeschlagen: Die Datei ist kein gültiger Export (${err.message}).`);
  }
});

// ---------- Notes ----------

function noteHtml(kind, keyword, html) {
  return `<div class="note ${kind}" role="note"><p><span class="cap">${keyword}</span>${html}</p></div>`;
}
function renderWarnings() {
  const msgs = validate(state.input);
  const box = $('#notes-achtung');
  box.innerHTML = msgs.length
    ? `<div class="note warn" role="alert"><p><span class="cap">ACHTUNG</span>Einige Eingaben passen nicht zusammen:</p><ul>${msgs.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>`
    : '';
}

// ---------- Diagramme (Inline-SVG) ----------

function svgEl(name, attrs = {}, text) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text !== undefined) el.textContent = text;
  return el;
}
function niceTicks(min, max, count = 5) {
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
function frame(container, minH = 240, top = 20) {
  const w = Math.max(280, Math.floor(container.clientWidth || 600));
  const h = Math.round(Math.min(380, Math.max(minH, w * 0.48)));
  const pad = { l: w < 480 ? 66 : 76, r: w < 480 ? 14 : 24, t: top, b: 36 };
  const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h, 'aria-hidden': 'true', focusable: 'false' });
  return { svg, w, h, pad, iw: w - pad.l - pad.r, ih: h - pad.t - pad.b };
}
function legend(el, items) {
  el.innerHTML = items.map(({ cls, text }) => {
    const style = {
      'l-acc': 'stroke:var(--accent);stroke-width:3',
      'l-ink': 'stroke:var(--ink);stroke-width:2;stroke-dasharray:6 4',
      'l-acc2': 'stroke:var(--ink);stroke-width:1.5;stroke-dasharray:2 3',
      mark: 'stroke:var(--ink);stroke-width:2',
      'mark dash': 'stroke:var(--ink);stroke-width:2;stroke-dasharray:4 3',
    }[cls];
    const shape = cls === 'bar'
      ? '<rect x="0" y="2" width="28" height="10" style="fill:var(--accent)"/>'
      : `<line x1="0" y1="7" x2="28" y2="7" style="${style}"/>`;
    return `<li><svg width="28" height="14" aria-hidden="true">${shape}</svg><span>${esc(text)}</span></li>`;
  }).join('');
}

let last = null; // letzte deterministische Rechnung
let mc = null;   // letztes Simulationsergebnis

function drawOverview() {
  const box = $('#chart-overview');
  if (!last || box.offsetParent === null) return;
  const { svg, w, h, pad, iw, ih } = frame(box);
  const H = last.model.horizonYears;
  const sA = last.without.series, sB = last.withLoan.series;
  const pts = (s) => s.filter((p) => p.month % 12 === 0).map((p) => [p.month / 12, pick(p, state.view)]);
  const a = pts(sA), b = pts(sB);
  const all = a.concat(b).map((p) => p[1]);
  const ymin = Math.min(0, ...all), ymax = Math.max(TARGET * 1.1, ...all);
  const yt = niceTicks(ymin, ymax, 5);
  const y0 = yt[0], y1 = yt[yt.length - 1];
  const X = (x) => pad.l + (H ? (x / H) * iw : 0);
  const Y = (v) => pad.t + ih - ((v - y0) / (y1 - y0)) * ih;
  for (const t of yt) {
    svg.append(svgEl('line', { class: 'gridl', x1: pad.l, x2: w - pad.r, y1: Y(t), y2: Y(t) }));
    svg.append(svgEl('text', { x: pad.l - 8, y: Y(t) + 4, 'text-anchor': 'end' }, short(t)));
  }
  const xt = niceTicks(0, H, w < 480 ? 4 : 6).filter((t) => t <= H);
  for (const t of xt) {
    svg.append(svgEl('line', { class: 'axis', x1: X(t), x2: X(t), y1: pad.t + ih, y2: pad.t + ih + 5 }));
    svg.append(svgEl('text', { x: X(t), y: h - 14, 'text-anchor': 'middle' }, `${t} J.`));
  }
  svg.append(svgEl('line', { class: 'axis', x1: pad.l, x2: w - pad.r, y1: Y(Math.max(0, y0)), y2: Y(Math.max(0, y0)) }));
  svg.append(svgEl('line', { class: 'target', x1: pad.l, x2: w - pad.r, y1: Y(TARGET), y2: Y(TARGET) }));
  svg.append(svgEl('text', { x: pad.l + 6, y: Y(TARGET) - 6 }, '100.000 €'));
  const path = (p) => p.map((q, i) => `${i ? 'L' : 'M'}${X(q[0]).toFixed(1)},${Y(q[1]).toFixed(1)}`).join('');
  svg.append(svgEl('path', { class: 'l-ink', d: path(a) }));
  svg.append(svgEl('path', { class: 'l-acc', d: path(b) }));
  const g = last.model.graceMonths / 12;
  if (last.model.loan > 0 && g > 0 && g < H) {
    svg.append(svgEl('line', { class: 'mark dash', x1: X(g), x2: X(g), y1: pad.t, y2: pad.t + ih }));
    svg.append(svgEl('text', { x: X(g) + 4, y: pad.t + 12 }, 'Tilgung'));
  }
  const ea = a[a.length - 1], eb = b[b.length - 1];
  if (eb) {
    svg.append(svgEl('circle', { class: 'dot', cx: X(eb[0]), cy: Y(eb[1]), r: 4 }));
    svg.append(svgEl('text', { class: 'lbl-acc', x: X(eb[0]) - 6, y: Y(eb[1]) - 10, 'text-anchor': 'end' }, `mit: ${short(eb[1])}`));
  }
  if (ea) svg.append(svgEl('text', { class: 'lbl', x: X(ea[0]) - 6, y: Y(ea[1]) + (ea[1] < eb[1] ? 18 : -10), 'text-anchor': 'end' }, `ohne: ${short(ea[1])}`));
  box.replaceChildren(svg);
  box.setAttribute('aria-label', `Verlauf über ${H} Jahre: ohne Darlehen am Ende ${fmtEur(ea[1])}, mit Darlehen ${fmtEur(eb[1])} (${viewLabel()}).`);
  legend($('#legend-overview'), [
    { cls: 'l-ink', text: 'ohne Darlehen (gestrichelt)' },
    { cls: 'l-acc', text: 'mit Darlehen (durchgezogen)' },
  ]);
  $('#cap-overview').textContent = `Gesamtvermögen ohne und mit Darlehen, ${viewLabel()}`;
}

function drawHistogram() {
  const box = $('#chart-hist');
  if (!mc || box.offsetParent === null) return;
  const hst = mc.histogram;
  const { svg, w, h, pad, iw, ih } = frame(box, 260, 48);
  const maxC = Math.max(...hst.counts, 1);
  const X = (v) => pad.l + ((v - hst.lo) / (hst.hi - hst.lo || 1)) * iw;
  const Y = (c) => pad.t + ih - (c / maxC) * ih;
  const yt = niceTicks(0, (maxC / mc.runs) * 100, 4);
  const yMaxPct = yt[yt.length - 1];
  const Yp = (pct) => pad.t + ih - (pct / yMaxPct) * ih;
  for (const t of yt) {
    svg.append(svgEl('line', { class: 'gridl', x1: pad.l, x2: w - pad.r, y1: Yp(t), y2: Yp(t) }));
    svg.append(svgEl('text', { x: pad.l - 8, y: Yp(t) + 4, 'text-anchor': 'end' }, `${fmtNum(t, t < 1 ? 1 : 0)} %`));
  }
  const bw = iw / hst.counts.length;
  hst.counts.forEach((c, i) => {
    const pct = (c / mc.runs) * 100;
    const y = Yp(pct);
    svg.append(svgEl('rect', { class: 'bar', x: (pad.l + i * bw + 1).toFixed(1), y: y.toFixed(1), width: Math.max(1, bw - 2).toFixed(1), height: (pad.t + ih - y).toFixed(1) }));
  });
  svg.append(svgEl('line', { class: 'axis', x1: pad.l, x2: w - pad.r, y1: pad.t + ih, y2: pad.t + ih }));
  const xt = niceTicks(hst.lo, hst.hi, w < 480 ? 3 : 6).filter((t) => t >= hst.lo && t <= hst.hi);
  for (const t of xt) svg.append(svgEl('text', { x: X(t), y: h - 14, 'text-anchor': 'middle' }, short(t)));
  const markers = [
    { v: hst.median, cls: 'mark', text: `Median ${short(hst.median)}` },
    { v: hst.p5, cls: 'mark dash', text: `5 % ${short(hst.p5)}` },
  ];
  markers.forEach((mk, i) => {
    const x = X(mk.v);
    const ly = 16 + i * 16;
    svg.append(svgEl('line', { class: mk.cls, x1: x, x2: x, y1: ly + 4, y2: pad.t + ih }));
    const right = x + 120 < w - pad.r;
    svg.append(svgEl('text', { class: 'lbl', x: right ? x + 6 : x - 6, y: ly, 'text-anchor': right ? 'start' : 'end' }, mk.text));
  });
  box.replaceChildren(svg);
  box.setAttribute('aria-label', `Histogramm von ${fmtNum(mc.runs)} Durchläufen: Median ${fmtEur(hst.median)}, 5-%-Perzentil ${fmtEur(hst.p5)}.`);
  legend($('#legend-hist'), [
    { cls: 'bar', text: 'Anteil der Durchläufe' },
    { cls: 'mark', text: 'Median (durchgezogen)' },
    { cls: 'mark dash', text: '5-%-Perzentil (gestrichelt)' },
  ]);
  $('#cap-hist').textContent = `Verteilung des Gesamtvermögens mit Darlehen nach ${mc.horizonYears} Jahren, brutto, nominal; 1.–99. Perzentil`;
}

function drawRates() {
  const box = $('#chart-rates');
  if (!mc || box.offsetParent === null || !mc.rates.length) return;
  const { svg, w, h, pad, iw, ih } = frame(box);
  const rows = mc.rates;
  const vals = rows.flatMap((r) => [r.median, r.p5]);
  const yt = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals), 5);
  const y0 = yt[0], y1 = yt[yt.length - 1];
  const xmax = rows[rows.length - 1].rate;
  const X = (x) => pad.l + (x / xmax) * iw;
  const Y = (v) => pad.t + ih - ((v - y0) / (y1 - y0)) * ih;
  for (const t of yt) {
    svg.append(svgEl('line', { class: t === 0 ? 'zero' : 'gridl', x1: pad.l, x2: w - pad.r, y1: Y(t), y2: Y(t) }));
    svg.append(svgEl('text', { x: pad.l - 8, y: Y(t) + 4, 'text-anchor': 'end' }, short(t)));
  }
  for (const r of rows) {
    if (w < 480 && r.rate % 2) continue;
    svg.append(svgEl('text', { x: X(r.rate), y: h - 14, 'text-anchor': 'middle' }, `${r.rate} %`));
  }
  const path = (key) => rows.map((r, i) => `${i ? 'L' : 'M'}${X(r.rate).toFixed(1)},${Y(r[key]).toFixed(1)}`).join('');
  svg.append(svgEl('path', { class: 'l-acc2', d: path('p5') }));
  svg.append(svgEl('path', { class: 'l-acc', d: path('median') }));
  rows.forEach((r) => svg.append(svgEl('circle', { class: 'dot', cx: X(r.rate), cy: Y(r.median), r: 3.5 })));
  if (mc.breakEvenRate !== null) {
    const x = X(mc.breakEvenRate);
    svg.append(svgEl('line', { class: 'mark', x1: x, x2: x, y1: pad.t, y2: pad.t + ih }));
    const right = x + 150 < w - pad.r;
    svg.append(svgEl('text', { class: 'lbl', x: right ? x + 6 : x - 6, y: pad.t + 12, 'text-anchor': right ? 'start' : 'end' }, `Zinsgrenze ${fmtNum(mc.breakEvenRate, 1)} %`));
  }
  box.replaceChildren(svg);
  legend($('#legend-rates'), [
    { cls: 'l-acc', text: 'Median-Gewinn (durchgezogen)' },
    { cls: 'l-acc2', text: '5-%-Fall (gepunktet)' },
    { cls: 'mark', text: 'Zinsgrenze' },
  ]);
}

function renderCharts() {
  drawOverview(); drawHistogram(); drawRates();
}
let resizeTimer;
const ro = new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderCharts, 80); });
['#chart-overview', '#chart-hist', '#chart-rates'].forEach((s) => ro.observe($(s)));

// ---------- № 02 Überblick ----------

function kpi(k, v, s = '', acc = false) {
  return `<div class="kpi"><span class="k cap">${k}</span><span class="v${acc ? ' acc' : ''}">${v}</span>${s ? `<span class="s">${s}</span>` : ''}</div>`;
}
function renderOverview() {
  const r = last;
  const age = fmtNum(state.input.ageTarget, 0);
  const m = r.model;
  const startYear = m.graceMonths / 12;
  const interest = m.i > 0 ? `; dazu Zinsen anfangs ${fmtEur(r.interestMonthly)} pro Monat` : '';
  const rateSub = m.loan <= 0 ? 'kein Darlehen'
    : m.plan.mode === 'standard'
      ? `ab Jahr ${fmtNum(startYear + 1, 0)} für ${fmtNum(m.termMonths / 12, 0)} Jahre, Variante ${m.variant}${interest}`
      : `${m.plan.mode === 'simple' ? 'einfacher' : 'individueller'} Plan ab ${fmtMonth(addMonths(m.ref, m.graceMonths + 1))}, Variante ${m.variant}${interest}`;
  const ageAt = (y) => (y === null ? '' : `mit ${fmtNum(state.input.ageNow + y, 0)} Jahren`);
  $('#kpis').innerHTML = [
    kpi(`Vermögen mit ${age} ohne Darlehen`, fmtEur(r.finalWithout)),
    kpi(`Vermögen mit ${age} mit Darlehen`, fmtEur(r.finalWith)),
    kpi('Unterschied', signedEur(r.diff), r.diff >= 0 ? 'Vorteil durch das Darlehen' : 'Nachteil durch das Darlehen', true),
    kpi('Jahre bis 100.000 € ohne', fmtYears(r.yearsWithout), ageAt(r.yearsWithout)),
    kpi('Jahre bis 100.000 € mit', fmtYears(r.yearsWith), ageAt(r.yearsWith)),
    kpi('Monatliche Rate', m.loan > 0 ? fmtEur(r.payment) : '–', rateSub),
  ].join('');
}

// ---------- № 03 Szenarien ----------

function renderScenarios() {
  const growths = [0, 5, 10, 15, 20];
  const savings = [200, 400];
  const age = fmtNum(state.input.ageTarget, 0);
  let rows = '';
  for (const g of growths) {
    for (const s of savings) {
      const r = compare(inp({ cryptoGrowth: g, savings: s }), state.view);
      const cur = g === Number(state.input.cryptoGrowth) && s === Number(state.input.savings);
      rows += `<tr${cur ? ' class="mark"' : ''}><th scope="row">${fmtNum(g, 0)} %${cur ? ' <span class="tag acc">aktuell</span>' : ''}</th><td class="num">${fmtEur(s)}</td>`
        + `<td class="num">${fmtYears(r.yearsWithout)}</td><td class="num">${fmtYears(r.yearsWith)}</td>`
        + `<td class="num">${fmtEur(r.finalWithout)}</td><td class="num">${fmtEur(r.finalWith)}</td></tr>`;
    }
  }
  $('#table-scenarios').innerHTML = `<caption>Tabelle: ${viewLabel()}; Darlehen ${fmtEur(state.input.loan)}, Variante ${state.input.variant}</caption>
    <thead><tr><th scope="col">Krypto p. a.</th><th scope="col" class="num">Sparrate</th><th scope="col" class="num">Jahre bis 100.000 € ohne</th><th scope="col" class="num">Jahre bis 100.000 € mit</th><th scope="col" class="num">Vermögen mit ${age} ohne</th><th scope="col" class="num">Vermögen mit ${age} mit</th></tr></thead>
    <tbody>${rows}</tbody>`;
}

// ---------- № 06 Meilensteine ----------

function renderMilestones() {
  const targets = [200000, 300000, 500000, 1000000];
  const maxYears = 70;
  let rows = '';
  for (const s of [200, 400]) {
    for (const r of [5, 6, 7]) {
      const ys = milestones(inp({ savings: s, etfReturn: r }), targets, maxYears);
      const cur = s === Number(state.input.savings) && r === Number(state.input.etfReturn);
      rows += `<tr${cur ? ' class="mark"' : ''}><th scope="row">${fmtEur(s)}${cur ? ' <span class="tag acc">aktuell</span>' : ''}</th><td class="num">${fmtNum(r, 0)} %</td>`
        + ys.map((y) => `<td class="num">${y === null ? `über ${maxYears} J.` : `${fmtNum(y, 1)} J.<br><span class="muted">Alter ${fmtNum(state.input.ageNow + y, 0)}</span>`}</td>`).join('')
        + '</tr>';
    }
  }
  $('#table-milestones').innerHTML = `<caption>Tabelle: Jahre ab heute bis zum Meilenstein, mit Darlehen, brutto, nominal; Krypto ${fmtNum(state.input.cryptoGrowth, 1)} % p. a.</caption>
    <thead><tr><th scope="col">Sparrate</th><th scope="col" class="num">ETF-Rendite</th>${targets.map((t) => `<th scope="col" class="num">${t >= 1e6 ? '1 Mio. €' : fmtEur(t)}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody>`;
}

// ---------- № 04 und № 05: Simulation im Web Worker ----------

let worker = null, jobId = 0, mcTimer = null, busy = false;
function startWorker() {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => {
    const d = ev.data;
    if (d.id !== jobId) return;
    if (d.progress !== undefined && !d.result) { $('#mc-status').textContent = `Simulation läuft … ${fmtNum(d.progress * 100, 0)} %`; return; }
    busy = false;
    if (d.error) { $('#mc-status').textContent = `Simulation fehlgeschlagen: ${d.error}`; return; }
    mc = d.result;
    $('#mc-status').textContent = `${fmtNum(mc.runs)} Durchläufe, Zufallswert ${mc.seed}.`;
    renderRisk(); renderRates();
  };
  worker.onerror = (e) => { busy = false; $('#mc-status').textContent = `Simulation nicht verfügbar: ${e.message || 'Web Worker konnte nicht starten'}.`; };
}
function scheduleMc() {
  clearTimeout(mcTimer);
  $('#mc-status').textContent = 'Simulation wartet auf Eingaben …';
  mcTimer = setTimeout(runMc, 350);
}
function runMc() {
  if (!('Worker' in window)) { $('#mc-status').textContent = 'Dieser Browser unterstützt keine Web Worker; die Simulation ist nicht verfügbar.'; return; }
  if (busy && worker) { worker.terminate(); worker = null; } // veraltete Rechnung abbrechen
  if (!worker) startWorker();
  jobId++; busy = true;
  $('#mc-status').textContent = 'Simulation läuft … 0 %';
  worker.postMessage({ id: jobId, input: inp(), rates: RATES });
}

function renderRisk() {
  if (!mc) return;
  const g = fmtNum(mc.graceYears, 0);
  const age = fmtNum(state.input.ageTarget, 0);
  const hasLoan = mc.loan > 0;
  $('#note-risiko').innerHTML = hasLoan && mc.probBelowLoan > 0.10
    ? noteHtml('err', 'RISIKO', `Mit ${fmtPct(mc.probBelowLoan)} Wahrscheinlichkeit ist das Darlehensgeld im ETF nach ${g} Jahren weniger wert als das Darlehen (${fmtEur(mc.loan)}). Im schlechten Fall (5 %) fehlen ${fmtEur(mc.gapP5)}, die aus eigenem Geld kommen müssen.`)
    : hasLoan ? '' : noteHtml('info', 'HINWEIS', 'Ohne Darlehen gibt es keine Lücke. Die Werte unten zeigen nur die Schwankung des eigenen Vermögens.');
  const items = [
    kpi(`Median mit ${age}, mit Darlehen`, fmtEur(mc.withLoan.median), `ohne Darlehen ${fmtEur(mc.without.median)}`),
    kpi(`5-%-Perzentil mit ${age}`, fmtEur(mc.withLoan.p5), `ohne Darlehen ${fmtEur(mc.without.p5)}`),
    kpi(`ETF nach ${g} J. unter Darlehen`, hasLoan ? fmtPct(mc.probBelowLoan) : '–', 'Wahrscheinlichkeit', hasLoan && mc.probBelowLoan > 0.10),
    kpi('Lücke im schlechten Fall (5 %)', hasLoan ? fmtEur(mc.gapP5) : '–', `nach ${g} Jahren`),
    kpi('Durchläufe mit Verlust', hasLoan ? fmtPct(mc.probLoss) : '–', `mit Darlehen weniger als ohne, mit ${age}`),
  ];
  if (mc.probLoanDepotShort !== null) items.push(kpi('Variante B: Depot reicht nicht', fmtPct(mc.probLoanDepotShort), mc.probDepotShort > 0 ? `auch mit eigenem ETF nicht: ${fmtPct(mc.probDepotShort)}` : 'Darlehens-Depot reicht nicht für alle Raten; Rest aus eigenem ETF'));
  $('#risk-kpis').innerHTML = items.join('');
  $('#table-risk').innerHTML = `<caption>Tabelle: Ergebnisse der Simulation, brutto, nominal</caption>
    <thead><tr><th scope="col">Kennzahl</th><th scope="col" class="num">ohne Darlehen</th><th scope="col" class="num">mit Darlehen</th><th scope="col" class="num">Gewinn durch Darlehen</th></tr></thead>
    <tbody>
      <tr><th scope="row">95-%-Perzentil (guter Fall)</th><td class="num">${fmtEur(mc.without.p95)}</td><td class="num">${fmtEur(mc.withLoan.p95)}</td><td class="num">${signedEur(mc.gain.p95)}</td></tr>
      <tr><th scope="row">Median</th><td class="num">${fmtEur(mc.without.median)}</td><td class="num">${fmtEur(mc.withLoan.median)}</td><td class="num">${signedEur(mc.gain.median)}</td></tr>
      <tr><th scope="row">5-%-Perzentil (schlechter Fall)</th><td class="num">${fmtEur(mc.without.p5)}</td><td class="num">${fmtEur(mc.withLoan.p5)}</td><td class="num">${signedEur(mc.gain.p5)}</td></tr>
      <tr><th scope="row">Darlehensgeld im ETF nach ${g} J., Median</th><td class="num">–</td><td class="num">${hasLoan ? fmtEur(mc.loanEtfAtGrace.median) : '–'}</td><td class="num">–</td></tr>
      <tr><th scope="row">Darlehensgeld im ETF nach ${g} J., 5 %</th><td class="num">–</td><td class="num">${hasLoan ? fmtEur(mc.loanEtfAtGrace.p5) : '–'}</td><td class="num">–</td></tr>
    </tbody>`;
  $('#mc-method').textContent = `Methode: ${fmtNum(mc.runs)} Durchläufe mit festem Zufallswert (${mc.seed}), logarithmische Normalverteilung der Monatsrenditen mit mu = ln(1 + ${fmtNum(state.input.etfReturn, 1)} %)/12 und sigma = ${fmtNum(state.input.volatility, 1)} %/√12. Krypto wächst fest mit ${fmtNum(state.input.cryptoGrowth, 1)} % pro Jahr.`;
  drawHistogram();
}

function renderRates() {
  if (!mc) return;
  const be = mc.breakEvenRate;
  const curRate = Number(state.input.loanRate);
  $('#be-text').innerHTML = mc.loan <= 0
    ? 'Ohne Darlehen gibt es keine Zinsgrenze. Lege in № 01 einen Darlehensbetrag fest.'
    : be === null
      ? `Bis 8 % Darlehenszins bleibt der Median-Gewinn durch das Darlehen positiv (Darlehen ${fmtEur(mc.loan)}, Variante ${state.input.variant}).`
      : `Ab etwa <b>${fmtNum(be, 1)} %</b> Darlehenszins fällt der Median-Gewinn durch das Darlehen unter null (Darlehen ${fmtEur(mc.loan)}, Variante ${state.input.variant}, ETF-Rendite ${fmtNum(state.input.etfReturn, 1)} %). Die Zinsen werden jährlich aus dem Einkommen bezahlt und fehlen damit im eigenen Depot.`;
  const rows = mc.rates.map((r) => {
    const cur = Math.round(curRate) === r.rate;
    const below = r.median < 0;
    return `<tr${cur ? ' class="mark"' : ''}><th scope="row">${fmtNum(r.rate, 0)} %${cur ? ' <span class="tag acc">aktuell</span>' : ''}</th>`
      + `<td class="num">${signedEur(r.median)}${below ? '<br><span class="tag">unter null</span>' : ''}</td>`
      + `<td class="num">${fmtPct(r.probLoss)}</td><td class="num">${signedEur(r.p5)}</td></tr>`;
  }).join('');
  $('#table-rates').innerHTML = `<caption>Tabelle: Gewinn durch das Darlehen mit ${fmtNum(state.input.ageTarget, 0)} (mit minus ohne), brutto, nominal, ${fmtNum(mc.runs)} Durchläufe</caption>
    <thead><tr><th scope="col">Zins</th><th scope="col" class="num">Median-Gewinn</th><th scope="col" class="num">Verlustwahrscheinlichkeit</th><th scope="col" class="num">5-%-Fall</th></tr></thead>
    <tbody>${rows}</tbody>`;
  drawRates();
}

// ---------- № 03 Rückzahlung (Entnahmeplan) ----------

const planForm = $('#plan-form');
planForm.addEventListener('submit', (e) => e.preventDefault());
function syncPlanForm() {
  $$('input[name="planMode"]', planForm).forEach((r) => { r.checked = r.value === state.input.planMode; });
  const amount = $('#in-planAmount'), start = $('#in-planStart');
  if (document.activeElement !== amount) amount.value = String(state.input.planAmount);
  if (document.activeElement !== start) start.value = state.input.planStart;
  $('#plan-custom').hidden = state.input.planMode !== 'custom';
  $('#plan-variant-text').textContent = state.input.variant === 'A'
    ? 'Variante A: Die Raten kommen aus dem Einkommen und fehlen in der Sparrate.'
    : 'Variante B: Die Raten werden durch Verkauf aus dem ETF bezahlt; auf den Gewinnanteil fällt Steuer an.';
}
planForm.addEventListener('input', (e) => {
  const el = e.target;
  if (el.name === 'planMode') {
    state.input.planMode = el.value;
    if (el.value === 'custom' && !state.input.planCustom.length) generateCustomPlan();
    renderPlanEditor();
  } else if (el.name === 'planAmount') {
    if (el.value === '') return;
    state.input.planAmount = Math.max(0, Number(el.value) || 0);
  } else if (el.name === 'planStart') {
    if (el.value !== '' && !/^\d{4}-\d{2}$/.test(el.value)) return;
    state.input.planStart = el.value;
  } else return;
  persist(); syncForm(); update();
});
function defaultStart() {
  const m = toModel(inp({ planMode: 'standard' }));
  return state.input.planStart || addMonths(m.ref, m.graceMonths + 1);
}
function generateCustomPlan() {
  const amount = Number(state.input.planAmount) > 0 ? Number(state.input.planAmount) : toModel(inp({ planMode: 'standard' })).loan / Math.max(1, Number(state.input.term) * 12);
  state.input.planCustom = buildCustomPlan(Number(state.input.loan), amount, defaultStart());
}
$('#btn-plan-generate').addEventListener('click', () => { generateCustomPlan(); persist(); renderPlanEditor(); update(); });
$('#btn-plan-add').addEventListener('click', () => {
  const rows = state.input.planCustom;
  const next = rows.length ? addMonths(rows.reduce((a, r) => (r.m > a ? r.m : a), rows[0].m), 1) : defaultStart();
  rows.push({ m: next, a: rows.length ? rows[rows.length - 1].a : Number(state.input.planAmount) || 0 });
  persist(); renderPlanEditor(); update();
  const inputs = $$('#table-plan-edit input[data-f="a"]'); if (inputs.length) inputs[inputs.length - 1].focus();
});
$('#btn-plan-clear').addEventListener('click', () => { state.input.planCustom = []; persist(); renderPlanEditor(); update(); });

function renderPlanEditor() {
  const rows = state.input.planCustom;
  const sum = rows.reduce((s, r) => s + (Number(r.a) || 0), 0);
  $('#table-plan-edit').innerHTML = `<caption>Tabelle: ${rows.length} Monate, Summe ${fmtEur(sum, 2)} von ${fmtEur(state.input.loan)} Darlehen</caption>
    <thead><tr><th scope="col">Monat</th><th scope="col" class="num">Auszahlung (€)</th><th scope="col"><span class="vh">Aktion</span></th></tr></thead>
    <tbody>${rows.map((r, i) => `<tr>
      <td><input type="month" data-i="${i}" data-f="m" value="${esc(r.m)}" aria-label="Monat ${i + 1}" pattern="\\d{4}-\\d{2}" placeholder="JJJJ-MM"></td>
      <td class="num"><input type="number" data-i="${i}" data-f="a" value="${r.a}" min="0" step="10" inputmode="decimal" aria-label="Auszahlung ${fmtMonth(r.m)}"></td>
      <td><button class="btn small" type="button" data-del="${i}" aria-label="${fmtMonth(r.m)} löschen">Löschen</button></td></tr>`).join('')
      || '<tr><td colspan="3" class="muted">Noch keine Monate. „Aus „Betrag ab Monat“ erzeugen“ oder „Monat hinzufügen“.</td></tr>'}</tbody>`;
}
$('#table-plan-edit').addEventListener('input', (e) => {
  const el = e.target, i = Number(el.dataset.i), row = state.input.planCustom[i];
  if (!row) return;
  if (el.dataset.f === 'm') { if (!/^\d{4}-\d{2}$/.test(el.value)) return; row.m = el.value; }
  else { if (el.value === '') return; row.a = Math.max(0, Number(el.value) || 0); }
  persist(); update();
  const sum = state.input.planCustom.reduce((s, r) => s + (Number(r.a) || 0), 0);
  $('#table-plan-edit caption').textContent = `Tabelle: ${state.input.planCustom.length} Monate, Summe ${fmtEur(sum, 2)} von ${fmtEur(state.input.loan)} Darlehen`;
});
$('#table-plan-edit').addEventListener('click', (e) => {
  const b = e.target.closest('[data-del]');
  if (!b) return;
  state.input.planCustom.splice(Number(b.dataset.del), 1);
  persist(); renderPlanEditor(); update();
});

function renderPlan() {
  const p = repaymentPlan(inp());
  const B = p.variant === 'B';
  if (p.loan <= 0) {
    $('#plan-kpis').innerHTML = kpi('Darlehen', '–', 'Kein Darlehensbetrag in № 01; es gibt nichts zurückzuzahlen.');
    $('#table-plan-years').innerHTML = ''; $('#table-plan-months').innerHTML = '';
    return;
  }
  const items = [
    kpi('Erste Auszahlung', fmtMonth(p.first), p.first ? `in ${fmtNum(monthDiff(p.ref, p.first) / 12, 1)} Jahren` : 'keine Zahlung geplant'),
    kpi('Letzte Auszahlung', fmtMonth(p.last), p.count ? `${p.count} Monate` : ''),
    kpi('Monatliche Auszahlung', fmtEur(p.typical, p.typical % 1 ? 2 : 0), p.mode === 'custom' ? 'erste Rate; Monate einzeln anpassbar' : 'bis die Schuld getilgt ist'),
    kpi('Summe an die Eltern', fmtEur(p.total), `Darlehen ${fmtEur(p.loan)}`),
    kpi('Restschuld am Horizont', fmtEur(p.debtEnd), p.debtEnd > 0.5 ? 'nicht vollständig getilgt' : 'vollständig getilgt', p.debtEnd > 0.5),
  ];
  if (B) items.push(kpi('Steuer auf Verkäufe', fmtEur(p.taxTotal), `verkauft aus dem ETF: ${fmtEur(p.soldTotal)}`));
  $('#plan-kpis').innerHTML = items.join('');
  // Jahresübersicht
  const years = new Map();
  for (const r of p.rows) {
    const y = r.month.slice(0, 4);
    const a = years.get(y) || { n: 0, pay: 0, sold: 0, tax: 0, debt: 0 };
    a.n++; a.pay += r.pay; a.sold += r.sold; a.tax += r.tax; a.debt = r.debt;
    years.set(y, a);
  }
  const bCols = (a) => (B ? `<td class="num">${fmtEur(a.sold)}</td><td class="num">${fmtEur(a.tax)}</td>` : '');
  $('#table-plan-years').innerHTML = `<caption>Tabelle: Rückzahlung je Kalenderjahr, Variante ${p.variant}${B ? ', Verkauf aus dem ETF bei fester Rendite' : ''}</caption>
    <thead><tr><th scope="col">Jahr</th><th scope="col" class="num">Monate</th><th scope="col" class="num">Auszahlung</th>${B ? '<th scope="col" class="num">verkauft</th><th scope="col" class="num">Steuer</th>' : ''}<th scope="col" class="num">Restschuld Jahresende</th></tr></thead>
    <tbody>${[...years].map(([y, a]) => `<tr><th scope="row">${y}</th><td class="num">${a.n}</td><td class="num">${fmtEur(a.pay)}</td>${bCols(a)}<td class="num">${fmtEur(a.debt)}</td></tr>`).join('')
      || `<tr><td colspan="${B ? 6 : 4}" class="muted">Keine Auszahlung im Horizont.</td></tr>`}</tbody>`;
  const det = $('#plan-months-details');
  const fillMonths = () => {
    $('#table-plan-months').innerHTML = `<caption>Tabelle: alle ${p.count} Monate</caption>
      <thead><tr><th scope="col">Monat</th><th scope="col" class="num">Auszahlung</th>${B ? '<th scope="col" class="num">verkauft</th><th scope="col" class="num">Steuer</th>' : ''}<th scope="col" class="num">Restschuld</th></tr></thead>
      <tbody>${p.rows.map((r) => `<tr><th scope="row">${fmtMonth(r.month)}</th><td class="num">${fmtEur(r.pay, 2)}</td>${B ? `<td class="num">${fmtEur(r.sold, 2)}</td><td class="num">${fmtEur(r.tax, 2)}</td>` : ''}<td class="num">${fmtEur(r.debt, 2)}</td></tr>`).join('')}</tbody>`;
  };
  det.ontoggle = () => { if (det.open) fillMonths(); };
  if (det.open) fillMonths();
}

// ---------- ETF-Kurs live (Yahoo Finance, nur auf Knopfdruck) ----------

function fmtStamp(iso) {
  if (!iso) return 'unbekannt';
  return new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function quoteSettings() { return { proxy: state.settings.proxy, allowPublic: state.settings.allowPublic }; }
function showQuoteStatus() {
  const q = state.quote;
  $('#quote-status').textContent = q
    ? `${q.symbol}: ${fmtNum(q.price, 2)} ${q.currency === 'EUR' ? '€' : q.currency} · ${q.name}${q.exchange ? `, ${q.exchange}` : ''} · Kursstand ${fmtStamp(q.time)} · abgerufen ${fmtStamp(q.fetchedAt)} über ${q.via}`
    : 'Noch kein Kurs abgerufen.';
}
/** Übernimmt Anteile × Kurs in „ETF-Bestand heute“ und „Darlehensgeld im ETF heute“. */
function applyQuote(announce = true) {
  const q = state.quote;
  if (!q) return;
  if (q.currency !== 'EUR') {
    $('#quote-note').innerHTML = noteHtml('warn', 'ACHTUNG', `Der Kurs von ${esc(q.symbol)} ist in ${esc(q.currency || 'unbekannter Währung')} angegeben. Die Rechnung läuft in Euro; bitte ein Euro-Listing wählen (zum Beispiel VWCE.DE). Die Bestände wurden nicht übernommen.`);
    return;
  }
  const changed = [];
  if (Number(state.input.etfShares) > 0) { state.input.etf = Math.round(state.input.etfShares * q.price * 100) / 100; changed.push(`ETF-Bestand heute ${fmtEur(state.input.etf, 2)}`); }
  if (Number(state.input.loanShares) > 0) { state.input.loanEtfNow = Math.round(state.input.loanShares * q.price * 100) / 100; changed.push(`Darlehensgeld im ETF ${fmtEur(state.input.loanEtfNow, 2)}`); }
  if (announce) {
    $('#quote-note').innerHTML = changed.length
      ? noteHtml('ok', 'AKTUELL', `Aus Anteilen × Kurs übernommen: ${changed.join(', ')}.`)
      : noteHtml('info', 'HINWEIS', 'Kurs abgerufen. Trage die Anzahl deiner Anteile ein, dann rechnet die App die Bestände automatisch aus.');
  }
}
$('#in-proxy').addEventListener('change', (e) => { state.settings.proxy = e.target.value.trim(); persist(); });
$('#in-allowPublic').addEventListener('change', (e) => { state.settings.allowPublic = e.target.checked; persist(); });
function failNote(err) {
  const body = !navigator.onLine
    ? 'Keine Verbindung. Gerechnet wird weiter mit dem zuletzt gespeicherten Kurs.'
    : `Der Kurs konnte nicht abgerufen werden. Versucht wurde:</p><ul>${(err.tried || [err.message]).map((t) => `<li>${esc(t)}</li>`).join('')}</ul><p>Abhilfe: unter „Abrufweg“ einen eigenen Proxy eintragen (Anleitung im README) oder den öffentlichen Proxy erlauben. Bis dahin bleiben die zuletzt gespeicherten Werte.`;
  return `<div class="note warn" role="alert"><p><span class="cap">ACHTUNG</span>${body}</p></div>`;
}
$('#btn-quote').addEventListener('click', async () => {
  const sym = ($('#in-etfSymbol').value || '').trim();
  state.input.etfSymbol = sym;
  if (!sym) { $('#quote-status').textContent = 'Bitte zuerst ein Symbol eingeben, zum Beispiel VWCE.DE.'; return; }
  const btn = $('#btn-quote');
  btn.disabled = true; $('#quote-note').innerHTML = '';
  $('#quote-status').textContent = `Kurs für ${sym} wird abgerufen …`;
  try {
    const r = await fetchQuote(sym, quoteSettings());
    state.quote = { ...r.data, via: r.via, fetchedAt: new Date().toISOString() };
    applyQuote(true);
    persist(); syncForm(); update();
  } catch (err) {
    $('#quote-note').innerHTML = failNote(err);
  } finally {
    btn.disabled = false; showQuoteStatus();
  }
});
$('#btn-search').addEventListener('click', async () => {
  const q = ($('#in-etfSymbol').value || '').trim();
  const box = $('#search-results');
  if (!q) { box.textContent = 'Bitte einen Namen eingeben, zum Beispiel „FTSE All-World“.'; return; }
  box.textContent = 'Suche läuft …';
  try {
    const r = await searchSymbols(q, quoteSettings());
    box.innerHTML = r.data.length
      ? r.data.map((x) => `<button class="btn small result-btn" type="button" data-sym="${esc(x.symbol)}">${esc(x.symbol)} · ${esc(x.name)}${x.exchange ? ` · ${esc(x.exchange)}` : ''}</button>`).join('')
      : 'Keine Treffer.';
  } catch (err) {
    box.innerHTML = ''; $('#quote-note').innerHTML = failNote(err);
  }
});
$('#search-results').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sym]');
  if (!b) return;
  state.input.etfSymbol = b.dataset.sym; $('#in-etfSymbol').value = b.dataset.sym;
  $('#search-results').innerHTML = ''; persist();
  $('#btn-quote').click();
});

// ---------- Ablauf ----------

function renderDeterministic() {
  last = compare(inp(), state.view);
  renderOverview(); renderPlan(); renderScenarios(); renderMilestones(); drawOverview();
}
function update() {
  renderWarnings();
  renderDeterministic();
  scheduleMc();
}

// ---------- Service Worker und UPDATE-Note ----------

function setupServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') {
    $('#foot-status').textContent = 'Ohne Offline-Modus (Service Worker nicht verfügbar)';
    return;
  }
  let waiting = null, userReload = false;
  const showUpdate = (w) => { waiting = w; $('#note-update').hidden = false; };
  navigator.serviceWorker.register('./sw.js', { scope: './' }).then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdate(w);
        if (w.state === 'activated') $('#foot-status').textContent = 'Offline bereit';
      });
    });
    if (navigator.serviceWorker.controller) $('#foot-status').textContent = 'Offline bereit';
  }).catch(() => { $('#foot-status').textContent = 'Offline-Modus nicht verfügbar'; });
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (userReload) location.reload(); });
  $('#btn-update').addEventListener('click', () => {
    userReload = true;
    if (waiting) waiting.postMessage({ type: 'SKIP_WAITING' });
    else location.reload();
  });
}

// ---------- Start ----------

applyTheme();
syncView();
syncForm();
selectTab(state.tab);
renderPlanEditor();
showQuoteStatus();
update();
setupServiceWorker();
window.addEventListener('storage', (e) => {
  if (e.key !== STORE_KEY) return;
  const s = storeGet(STORE_KEY);
  if (s && s.input) { state.input = sanitize(s.input); syncForm(); update(); }
});
