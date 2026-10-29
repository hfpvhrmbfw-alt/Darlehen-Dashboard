// Oberfläche des Vermögens: Übersicht, Positionen, Einzahlungen, Sicherungshinweis, Kursabruf und Tagesstände.
// Liest Uhr, Speicher und Netz; gerechnet wird in portfolio.js.
import { HOLDING_KINDS, RANGES, sanitizePortfolio } from './model.js';
import {
  totals, holdingValue, makeSnapshot, upsertSnapshot, series, periodChange, allocationCompare,
  staleSymbols, staleCurrencies, oldestQuote, backupDue, seedFromCalculator, dayNumber, dayString,
} from './portfolio.js';
import { fmtNum, fmtEur, fmtPct } from './format.js';
import { KIND_LABELS, SOURCE_LABELS, RANGE_LABELS } from './texts.js';
import { PORTFOLIO_KEY, load, save } from './storage.js';
import { fetchQuote } from './quotes.js';
import { $, esc, short, svgEl, niceTicks, frame, legend } from './ui-kit.js';

const eur = (c) => fmtEur(c / 100);
const eur2 = (c) => fmtEur(c / 100, 2);
const signed = (c) => `${c > 0 ? '+' : ''}${eur(c)}`;
const centsOf = (v) => Math.round(Number(String(v).replace(',', '.')) * 100);

/** Heute als lokales "JJJJ-MM-TT". */
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtDay(day, year = true) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('de-DE', year ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });
}
function fmtStamp(iso) {
  return new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function newId() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
function note(kind, cap, html) { return `<div class="note ${kind}" role="note"><p><span class="cap">${cap}</span>${html}</p></div>`; }
/** Veränderung als Pille: Pfeil und Vorzeichen tragen die Richtung, die Farbe nur zusätzlich. */
function delta(text, value) {
  const dir = value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
  const arrow = { up: '▲', down: '▼', flat: '■' }[dir];
  return `<span class="delta ${dir}"><span aria-hidden="true">${arrow}</span> ${text}</span>`;
}
function kpi(k, v, s = '', acc = false) {
  return `<div class="kpi"><span class="k cap">${k}</span><span class="v${acc ? ' acc' : ''}">${v}</span>${s ? `<span class="s">${s}</span>` : ''}</div>`;
}

/**
 * Startet die Vermögensseiten.
 * ctx.getInput(): Eingaben des Darlehen-Rechners (für Darlehen als Schuld und die Übernahme).
 * ctx.quoteSettings(): Abrufweg für Kurse (Proxy, öffentlicher Proxy erlaubt).
 */
export function initPortfolio(ctx) {
  let pf = sanitizePortfolio(load(PORTFOLIO_KEY));
  let quotesBusy = false, quoteFailed = [];

  const linkedDebt = () => (pf.settings.loanAsDebt ? Math.max(0, Math.round(Number(ctx.getInput().loan || 0) * 100)) : 0);
  const accName = (id) => (pf.accounts.find((a) => a.id === id) || { name: '–' }).name;
  const symbols = () => [...new Set(pf.holdings.map((h) => h.symbol).filter(Boolean))];

  /** Tagesstand von heute auffrischen, speichern, alles neu zeichnen. */
  function commit(renderEditors = true) {
    if (pf.holdings.length) pf.snapshots = upsertSnapshot(pf.snapshots, makeSnapshot(pf, today(), linkedDebt()));
    save(pf, PORTFOLIO_KEY);
    renderOverview();
    renderBackup();
    if (renderEditors) { renderAccounts(); renderDebts(); renderDeposits(); }
    showQuoteStatus();
  }

  // ---------- Kurse ----------

  function showQuoteStatus() {
    const el = $('#quotes-status');
    if (quotesBusy) { el.textContent = 'Kurse werden geladen …'; return; }
    const oldest = oldestQuote(pf);
    el.textContent = oldest ? `Kurse vom ${fmtStamp(oldest)}` : symbols().length ? 'Noch keine Kurse' : '';
    $('#btn-quotes').disabled = !symbols().length;
  }
  async function getRate(sym) {
    const r = await fetchQuote(sym, ctx.quoteSettings());
    return { ...r.data, via: r.via, fetchedAt: new Date().toISOString() };
  }
  /** Lädt Kurse und Wechselkurse. Ohne `force` nur, was fehlt oder älter als eine Stunde ist. */
  async function refreshQuotes(force = false) {
    if (quotesBusy || !navigator.onLine) { showQuoteStatus(); return; }
    const age = force ? -1 : 3600000;
    const syms = staleSymbols(pf, Date.now(), age);
    if (!syms.length && !staleCurrencies(pf, Date.now(), age).length) { showQuoteStatus(); return; }
    quotesBusy = true; showQuoteStatus(); $('#btn-quotes').disabled = true;
    const failed = [];
    for (const sym of syms) {
      try {
        const q = await getRate(sym);
        pf.prices[sym] = { price: q.price, currency: q.currency || 'EUR', time: q.time, fetchedAt: q.fetchedAt, via: q.via, name: q.name || null };
      } catch { failed.push(sym); }
    }
    for (const cur of staleCurrencies(pf, Date.now(), age)) {
      try {
        const q = await getRate(`${cur}EUR=X`);
        pf.fx[cur] = { rate: q.price, fetchedAt: q.fetchedAt };
      } catch { failed.push(`Wechselkurs ${cur} → EUR`); }
    }
    quotesBusy = false; quoteFailed = failed;
    commit(false);
    renderHoldingOutputs();
  }
  $('#btn-quotes').addEventListener('click', () => refreshQuotes(true));

  // ---------- Übersicht ----------

  function renderOverview() {
    const empty = !pf.holdings.length;
    $('#pf-empty').hidden = !empty;
    $('#pf-main').hidden = empty;
    if (empty) return;
    const day = today(), range = pf.settings.range;
    const t = totals(pf, linkedDebt());
    const pc = periodChange(pf.snapshots, range, day);
    const hasPeriod = pc.from !== pc.to;
    for (const b of $('#range-seg').querySelectorAll('[data-range]')) b.setAttribute('aria-pressed', String(b.dataset.range === range));
    $('#range-desc').textContent = hasPeriod
      ? `${RANGE_LABELS[range]}: ${fmtDay(pc.from)} bis ${fmtDay(pc.to)}`
      : `Der Verlauf beginnt am ${fmtDay(pf.snapshots[0] ? pf.snapshots[0].date : day)}. Jeden Tag, an dem du die App öffnest, kommt ein Stand dazu.`;

    const notes = [];
    if (backupDue(pf, day)) {
      notes.push(`<div class="note warn" role="note"><p><span class="cap">SICHERUNG</span>${pf.settings.lastBackup ? `Deine letzte Sicherung ist vom ${fmtDay(pf.settings.lastBackup)}.` : 'Du hast noch keine Sicherung gespeichert.'} Die Daten liegen nur in diesem Browser.</p><button class="btn small" type="button" data-goto="12">Zur Sicherung</button></div>`);
    }
    if (quoteFailed.length) {
      notes.push(note('warn', 'KURSE', `Nicht geladen: ${quoteFailed.map(esc).join(', ')}. Gerechnet wird mit dem letzten Kurs oder dem eingetragenen Wert. Den Abrufweg stellst du im Darlehen-Rechner unter „Eingaben“ ein.`));
    }
    if (t.missing) notes.push(note('info', 'HINWEIS', `${t.missing} ${t.missing === 1 ? 'Position hat' : 'Positionen haben'} noch keinen Wert. Trag unter „Positionen“ einen Wert ein oder lade die Kurse.`));
    $('#pf-notes').innerHTML = notes.join('');

    const pct = (r) => (r === null ? '' : `${r > 0 ? '+' : ''}${fmtPct(r, 1)}`);
    const diffRate = hasPeriod && pc.startNetCents > 0 ? pc.diffCents / pc.startNetCents : null;
    $('#pf-kpis').innerHTML = [
      kpi('Nettovermögen', eur(t.netCents), hasPeriod ? delta(pct(diffRate) || signed(pc.diffCents), pc.diffCents) : 'Anlagen minus Schulden', true),
      kpi('Veränderung', hasPeriod ? signed(pc.diffCents) : '–', hasPeriod ? `davon Einzahlungen ${signed(pc.depositsCents)}` : 'ab dem zweiten Tag'),
      kpi('Gewinn ohne Einzahlungen', hasPeriod ? signed(pc.gainCents) : '–', hasPeriod && pc.returnRate !== null ? delta(`${pct(pc.returnRate)} Rendite`, pc.gainCents) : 'Wertzuwachs ohne deine Sparrate'),
      kpi('Anlagen', eur(t.assetsCents), `${pf.holdings.length} ${pf.holdings.length === 1 ? 'Position' : 'Positionen'}`),
      kpi('Schulden', eur(t.debtCents), linkedDebt() ? 'inklusive Darlehen' : `${pf.debts.length} eingetragen`),
      kpi('Liquidität', eur(t.liquidCents), 'Konten und Tagesgeld'),
    ].join('');

    const byId = new Map(pf.holdings.map((h) => [h.id, h]));
    $('#table-pf').innerHTML = `<caption>Alle Positionen nach Wert. „Kurs“: Anteile × aktueller Kurs; „eingetragen“: dein Wert.</caption>
      <thead><tr><th scope="col">Position</th><th scope="col" class="hide-s">Konto</th><th scope="col" class="hide-s">Art</th><th scope="col" class="num">Wert</th><th scope="col" class="num">Anteil</th><th scope="col">Quelle</th></tr></thead>
      <tbody>${t.rows.map((r) => {
        const h = byId.get(r.holdingId);
        return `<tr><th scope="row">${esc(h.name)}${h.symbol ? ` <span class="muted">${esc(h.symbol)}</span>` : ''}</th><td class="hide-s">${esc(accName(r.accountId))}</td><td class="hide-s">${KIND_LABELS[r.kind]}</td><td class="num">${r.cents === null ? '–' : eur(r.cents)}</td><td class="num">${r.share === null ? '–' : fmtPct(r.share, 1)}</td><td><span class="tag src-${r.source}">${SOURCE_LABELS[r.source]}</span></td></tr>`;
      }).join('')}</tbody>
      <tfoot><tr class="sum"><th scope="row">Summe Anlagen</th><td class="hide-s"></td><td class="hide-s"></td><td class="num">${eur(t.assetsCents)}</td><td class="num">100 %</td><td></td></tr></tfoot>`;
    drawCharts();
  }

  function drawLine() {
    const box = $('#chart-pf-line');
    if (box.offsetParent === null) return;
    const day = today();
    const pts = series(pf.snapshots, pf.settings.range, day).map((p) => [dayNumber(p.date), p.netCents / 100]);
    const { svg, w, h, pad, iw, ih } = frame(box, 220);
    if (!pts.length) { box.replaceChildren(); return; }
    let x0 = pts[0][0], x1 = pts[pts.length - 1][0];
    if (x0 === x1) { x0 -= 1; x1 += 1; }
    const vals = pts.map((p) => p[1]);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const spread = Math.max(100, Math.abs(hi) * 0.04);
    if (hi - lo < spread) { lo -= spread / 2; hi += spread / 2; }
    const yt = niceTicks(lo, hi, 4);
    const y0 = yt[0], y1 = yt[yt.length - 1];
    const X = (x) => pad.l + ((x - x0) / (x1 - x0)) * iw;
    const Y = (v) => pad.t + ih - ((v - y0) / (y1 - y0)) * ih;
    // Bei engem Wertebereich mit Nachkommastelle, damit sich die Achsenwerte unterscheiden
    const step = yt.length > 1 ? yt[1] - yt[0] : 1000;
    const tick = (v) => (step >= 1000 || Math.abs(v) >= 1e6 || Math.abs(v) < 1000 ? short(v) : `${fmtNum(v / 1000, step >= 100 ? 1 : 2)} Tsd.`);
    for (const t of yt) {
      svg.append(svgEl('line', { class: 'gridl', x1: pad.l, x2: w - pad.r, y1: Y(t), y2: Y(t) }));
      svg.append(svgEl('text', { x: pad.l - 8, y: Y(t) + 4, 'text-anchor': 'end' }, tick(t)));
    }
    const longRange = x1 - x0 > 300;
    const nx = pts.length === 1 ? 1 : w < 480 ? 3 : 4;
    const ticks = pts.length === 1 ? [pts[0][0]] : Array.from({ length: nx + 1 }, (_, k) => Math.round(x0 + ((x1 - x0) * k) / nx));
    for (const t of [...new Set(ticks)]) {
      svg.append(svgEl('line', { class: 'axis', x1: X(t), x2: X(t), y1: pad.t + ih, y2: pad.t + ih + 5 }));
      svg.append(svgEl('text', { x: X(t), y: h - 14, 'text-anchor': t === x0 && pts.length > 1 ? 'start' : t === x1 && pts.length > 1 ? 'end' : 'middle' }, fmtDay(dayString(t), longRange)));
    }
    svg.append(svgEl('line', { class: 'axis', x1: pad.l, x2: w - pad.r, y1: pad.t + ih, y2: pad.t + ih }));
    const path = pts.map((q, i) => `${i ? 'L' : 'M'}${X(q[0]).toFixed(1)},${Y(q[1]).toFixed(1)}`).join('');
    if (pts.length > 1) {
      // Verlaufsfläche unter der Linie (wie im Grunddesign)
      const grad = svgEl('linearGradient', { id: 'pf-fill', x1: 0, y1: 0, x2: 0, y2: 1 });
      grad.append(svgEl('stop', { offset: '0', style: 'stop-color:var(--area);stop-opacity:.22' }), svgEl('stop', { offset: '1', style: 'stop-color:var(--area);stop-opacity:0' }));
      const defs = svgEl('defs'); defs.append(grad); svg.append(defs);
      const base = (pad.t + ih).toFixed(1);
      svg.append(svgEl('path', { class: 'area', fill: 'url(#pf-fill)', d: `${path}L${X(pts[pts.length - 1][0]).toFixed(1)},${base}L${X(pts[0][0]).toFixed(1)},${base}Z` }));
      svg.append(svgEl('path', { class: 'l-acc', d: path }));
    }
    const e = pts[pts.length - 1];
    svg.append(svgEl('circle', { class: 'dot', cx: X(e[0]), cy: Y(e[1]), r: 4 }));
    svg.append(svgEl('text', { class: 'lbl-acc', x: X(e[0]) - 8, y: Y(e[1]) - 10, 'text-anchor': 'end' }, short(e[1]) + ' €'));
    if (pts.length === 1) svg.append(svgEl('text', { class: 'lbl', x: pad.l + iw / 2, y: pad.t + 16, 'text-anchor': 'middle' }, 'Verlauf beginnt heute'));
    box.replaceChildren(svg);
    const f = pts[0];
    box.setAttribute('aria-label', pts.length === 1
      ? `Nettovermögen heute: ${fmtEur(e[1])}. Der Verlauf beginnt heute.`
      : `Nettovermögen von ${fmtEur(f[1])} am ${fmtDay(dayString(f[0]))} auf ${fmtEur(e[1])} am ${fmtDay(dayString(e[0]))}.`);
    $('#legend-pf-line').innerHTML = '';
  }

  function drawBars() {
    const box = $('#chart-pf-bars');
    if (box.offsetParent === null) return;
    const t = totals(pf, linkedDebt());
    const cmp = allocationCompare(pf.snapshots, today(), t.byKind);
    const kinds = HOLDING_KINDS.filter((k) => t.byKind[k] || (cmp.before && cmp.before[k]));
    const w = Math.max(260, Math.floor(box.clientWidth || 320));
    const labelW = 104, valueW = 64, rowH = cmp.before ? 42 : 30, top = 6;
    const h = top + Math.max(1, kinds.length) * rowH + 6;
    const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h, 'aria-hidden': 'true', focusable: 'false' });
    const max = Math.max(1, ...kinds.map((k) => Math.max(t.byKind[k], cmp.before ? cmp.before[k] : 0)));
    const bw = w - labelW - valueW;
    kinds.forEach((k, i) => {
      const y = top + i * rowH;
      const now = t.byKind[k] / 100;
      svg.append(svgEl('text', { x: 0, y: y + 13, class: 'lbl' }, KIND_LABELS[k]));
      svg.append(svgEl('rect', { class: 'bar', x: labelW, y: y + 3, width: Math.max(1, (t.byKind[k] / max) * bw).toFixed(1), height: 12, rx: 2 }));
      svg.append(svgEl('text', { x: labelW + Math.max(1, (t.byKind[k] / max) * bw) + 6, y: y + 13 }, short(now) + ' €'));
      if (cmp.before) {
        const b = cmp.before[k];
        svg.append(svgEl('rect', { class: 'bar prev', x: labelW, y: y + 19, width: Math.max(1, (b / max) * bw).toFixed(1), height: 8, rx: 2 }));
      }
    });
    box.replaceChildren(svg);
    box.setAttribute('aria-label', `Aufteilung nach Art heute: ${kinds.map((k) => `${KIND_LABELS[k]} ${eur(t.byKind[k])}`).join(', ')}${cmp.before ? `; am ${fmtDay(cmp.beforeDate)}: ${kinds.map((k) => `${KIND_LABELS[k]} ${eur(cmp.before[k])}`).join(', ')}` : ''}.`);
    legend($('#legend-pf-bars'), cmp.before
      ? [{ cls: 'bar', text: 'heute' }, { cls: 'bar prev', text: `am ${fmtDay(cmp.beforeDate)} (umrandet)` }]
      : [{ cls: 'bar', text: 'heute (Vergleich ab einem Monat Verlauf)' }]);
  }
  function drawCharts() { drawLine(); drawBars(); }

  $('#range-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-range]');
    if (!b || !RANGES.includes(b.dataset.range)) return;
    pf.settings.range = b.dataset.range;
    save(pf, PORTFOLIO_KEY); renderOverview();
  });
  $('#btn-seed').addEventListener('click', () => {
    const s = seedFromCalculator(ctx.getInput(), newId);
    if (!s.accounts.length) { s.accounts.push({ id: newId(), name: 'Depot' }); }
    pf.accounts.push(...s.accounts); pf.holdings.push(...s.holdings);
    commit(); refreshQuotes();
  });

  // ---------- Positionen ----------

  function valueCell(h) {
    const v = holdingValue(h, pf.prices, pf.fx);
    const p = h.symbol ? pf.prices[h.symbol] : null;
    const hint = v.source === 'kurs' ? `${fmtNum(p.price, 2)} ${p.currency === 'EUR' ? '€' : esc(p.currency)}` : SOURCE_LABELS[v.source];
    return `${v.cents === null ? '–' : eur2(v.cents)}<br><span class="tag src-${v.source}">${hint}</span>`;
  }
  function accountSum(id) {
    let s = 0;
    for (const h of pf.holdings) if (h.accountId === id) s += holdingValue(h, pf.prices, pf.fx).cents || 0;
    return s;
  }
  function renderAccounts() {
    const box = $('#pf-accounts');
    if (!pf.accounts.length) {
      box.innerHTML = note('info', 'START', 'Noch kein Konto. Leg unten ein Konto an, zum Beispiel „Depot“ oder „Tagesgeld“, oder übernimm die Werte aus dem Darlehen-Rechner in der Übersicht.');
      return;
    }
    box.innerHTML = pf.accounts.map((a) => {
      const rows = pf.holdings.filter((h) => h.accountId === a.id);
      const nm = esc(a.name);
      return `<div class="card acct" data-acc="${esc(a.id)}">
        <div class="acct-head">
          <input class="cell acct-name" type="text" data-f="accName" value="${nm}" aria-label="Name des Kontos" maxlength="80">
          <span class="acct-sum" data-out="accSum">${eur(accountSum(a.id))}</span>
          <button class="btn small ghost" type="button" data-act="delAcc">Konto löschen</button>
        </div>
        ${rows.length ? `<div class="table-scroll"><table class="data edit">
          <thead><tr><th scope="col">Name</th><th scope="col">Art</th><th scope="col">Symbol</th><th scope="col" class="num">Anteile</th><th scope="col" class="num">Wert eingetragen</th><th scope="col" class="num">Wert heute</th><th scope="col"><span class="vh">Entfernen</span></th></tr></thead>
          <tbody>${rows.map((h) => {
            const hn = esc(h.name);
            return `<tr data-h="${esc(h.id)}">
              <td data-label="Name"><input class="cell" type="text" data-f="name" value="${hn}" aria-label="Name der Position" maxlength="80"></td>
              <td data-label="Art"><select class="cell" data-f="kind" aria-label="Art von ${hn}">${HOLDING_KINDS.map((k) => `<option value="${k}"${k === h.kind ? ' selected' : ''}>${KIND_LABELS[k]}</option>`).join('')}</select></td>
              <td data-label="Symbol"><input class="cell sym" type="text" data-f="symbol" value="${esc(h.symbol || '')}" placeholder="z. B. VWCE.DE" aria-label="Symbol von ${hn}" autocapitalize="characters" spellcheck="false" maxlength="40"></td>
              <td class="num" data-label="Anteile"><input class="cell n" type="number" inputmode="decimal" min="0" step="any" data-f="quantity" value="${h.quantity ?? ''}" aria-label="Anteile von ${hn}"></td>
              <td class="num" data-label="Wert eingetragen (€)"><input class="cell n" type="number" inputmode="decimal" step="0.01" data-f="value" value="${h.valueCents === null ? '' : (h.valueCents / 100).toFixed(2)}" aria-label="Eingetragener Wert in Euro von ${hn}"></td>
              <td class="num" data-label="Wert heute" data-out="value">${valueCell(h)}</td>
              <td class="act"><button class="btn small ghost" type="button" data-act="delH" aria-label="${hn} entfernen">Entfernen</button></td>
            </tr>`;
          }).join('')}</tbody></table></div>` : '<p class="muted">Noch keine Positionen in diesem Konto.</p>'}
        <div class="toolbar"><button class="btn small" type="button" data-act="addH">Position hinzufügen</button></div>
      </div>`;
    }).join('');
  }
  /** Aktualisiert nur die berechneten Zellen, damit der Fokus beim Tippen bleibt. */
  function renderHoldingOutputs() {
    for (const h of pf.holdings) {
      const cell = $(`tr[data-h="${CSS.escape(h.id)}"] [data-out="value"]`);
      if (cell) cell.innerHTML = valueCell(h);
    }
    for (const a of pf.accounts) {
      const el = $(`[data-acc="${CSS.escape(a.id)}"] [data-out="accSum"]`);
      if (el) el.textContent = eur(accountSum(a.id));
    }
  }

  $('#pf-accounts').addEventListener('change', (e) => {
    const f = e.target.dataset.f;
    if (!f) return;
    const accEl = e.target.closest('[data-acc]');
    const acc = pf.accounts.find((a) => a.id === accEl.dataset.acc);
    if (f === 'accName') { acc.name = e.target.value.trim() || 'Konto'; commit(false); return; }
    const h = pf.holdings.find((x) => x.id === e.target.closest('[data-h]').dataset.h);
    const v = e.target.value;
    let fetchSym = false;
    if (f === 'name') h.name = v.trim() || 'Position';
    else if (f === 'kind') h.kind = HOLDING_KINDS.includes(v) ? v : 'sonstiges';
    else if (f === 'symbol') { h.symbol = v.trim().toUpperCase() || null; e.target.value = h.symbol || ''; fetchSym = !!h.symbol; }
    else if (f === 'quantity') h.quantity = v === '' || !Number.isFinite(Number(v)) ? null : Math.max(0, Number(v));
    else if (f === 'value') h.valueCents = v === '' || !Number.isFinite(centsOf(v)) ? null : centsOf(v);
    commit(false);
    renderHoldingOutputs();
    if (fetchSym) refreshQuotes();
  });
  $('#pf-accounts').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const accId = b.closest('[data-acc]').dataset.acc;
    if (b.dataset.act === 'addH') {
      const id = newId();
      pf.holdings.push({ id, accountId: accId, name: 'Neue Position', kind: 'etf', symbol: null, quantity: null, valueCents: null });
      commit();
      const inp = $(`tr[data-h="${CSS.escape(id)}"] [data-f="name"]`);
      if (inp) { inp.focus(); inp.select(); }
    } else if (b.dataset.act === 'delH') {
      const id = b.closest('[data-h]').dataset.h;
      pf.holdings = pf.holdings.filter((h) => h.id !== id);
      commit();
    } else if (b.dataset.act === 'delAcc') {
      const a = pf.accounts.find((x) => x.id === accId);
      const n = pf.holdings.filter((h) => h.accountId === accId).length;
      if (!confirm(`Konto „${a.name}“ mit ${n} ${n === 1 ? 'Position' : 'Positionen'} und seinen Einzahlungen löschen?`)) return;
      pf.accounts = pf.accounts.filter((x) => x.id !== accId);
      pf.holdings = pf.holdings.filter((h) => h.accountId !== accId);
      pf.deposits = pf.deposits.filter((d) => d.accountId !== accId);
      commit();
    }
  });
  $('#form-account').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#in-account-name').value.trim();
    if (!name) { $('#in-account-name').focus(); return; }
    const id = newId();
    pf.accounts.push({ id, name: name.slice(0, 80) });
    pf.holdings.push({ id: newId(), accountId: id, name: name.slice(0, 80), kind: /tagesgeld|giro|konto/i.test(name) ? 'cash' : 'etf', symbol: null, quantity: null, valueCents: null });
    $('#in-account-name').value = '';
    commit();
  });

  // ---------- Schulden ----------

  function renderDebts() {
    const loan = Number(ctx.getInput().loan || 0);
    $('#in-loanAsDebt').checked = pf.settings.loanAsDebt;
    $('#loan-debt-label').textContent = `Darlehen aus dem Darlehen-Rechner (${fmtEur(loan)}) als Schuld zählen`;
    const rows = pf.debts.map((d) => `<tr data-debt="${esc(d.id)}">
      <td data-label="Name"><input class="cell" type="text" data-f="name" value="${esc(d.name)}" aria-label="Name der Schuld" maxlength="80"></td>
      <td class="num" data-label="Betrag (€)"><input class="cell n" type="number" inputmode="decimal" min="0" step="0.01" data-f="amount" value="${(d.amountCents / 100).toFixed(2)}" aria-label="Betrag von ${esc(d.name)} in Euro"></td>
      <td class="act"><button class="btn small ghost" type="button" data-act="delDebt" aria-label="${esc(d.name)} entfernen">Entfernen</button></td></tr>`);
    if (pf.settings.loanAsDebt && loan > 0) rows.unshift(`<tr><td data-label="Name">Darlehen <span class="tag">aus dem Rechner</span></td><td class="num" data-label="Betrag">${fmtEur(loan, 2)}</td><td class="act"></td></tr>`);
    $('#table-debts').className = 'data edit';
    $('#table-debts').innerHTML = rows.length
      ? `<thead><tr><th scope="col">Name</th><th scope="col" class="num">Betrag</th><th scope="col"><span class="vh">Entfernen</span></th></tr></thead><tbody>${rows.join('')}</tbody>`
      : '<tbody><tr><td class="muted">Keine Schulden eingetragen.</td></tr></tbody>';
  }
  $('#in-loanAsDebt').addEventListener('change', (e) => { pf.settings.loanAsDebt = e.target.checked; commit(); });
  $('#btn-debt-add').addEventListener('click', () => {
    const id = newId();
    pf.debts.push({ id, name: 'Neue Schuld', amountCents: 0 });
    commit();
    const inp = $(`tr[data-debt="${CSS.escape(id)}"] [data-f="name"]`);
    if (inp) { inp.focus(); inp.select(); }
  });
  $('#table-debts').addEventListener('change', (e) => {
    const row = e.target.closest('[data-debt]');
    if (!row) return;
    const d = pf.debts.find((x) => x.id === row.dataset.debt);
    if (e.target.dataset.f === 'name') d.name = e.target.value.trim() || 'Schuld';
    else d.amountCents = Math.max(0, centsOf(e.target.value) || 0);
    commit(false);
  });
  $('#table-debts').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act="delDebt"]');
    if (!b) return;
    pf.debts = pf.debts.filter((d) => d.id !== b.closest('[data-debt]').dataset.debt);
    commit();
  });

  // ---------- Einzahlungen ----------

  function renderDeposits() {
    const sel = $('#in-dep-account');
    const keep = sel.value;
    sel.innerHTML = pf.accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
    if (pf.accounts.some((a) => a.id === keep)) sel.value = keep;
    if (!$('#in-dep-date').value) $('#in-dep-date').value = today();
    const none = !pf.accounts.length;
    for (const el of $('#form-deposit').querySelectorAll('input, select, button')) el.disabled = none;
    const hint = 'Leg zuerst unter „Positionen“ ein Konto an.';
    if (none) $('#dep-status').textContent = hint;
    else if ($('#dep-status').textContent === hint) $('#dep-status').textContent = '';
    const list = [...pf.deposits].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const sum = list.reduce((s, d) => s + d.amountCents, 0);
    $('#table-deposits').innerHTML = list.length
      ? `<thead><tr><th scope="col">Datum</th><th scope="col">Konto</th><th scope="col" class="num">Betrag</th><th scope="col"><span class="vh">Entfernen</span></th></tr></thead>
        <tbody>${list.map((d) => `<tr data-dep="${esc(d.id)}"><td>${fmtDay(d.date)}</td><td>${esc(accName(d.accountId))}</td><td class="num">${d.amountCents > 0 ? '+' : ''}${eur2(d.amountCents)}</td><td><button class="btn small ghost" type="button" data-act="delDep" aria-label="Eintrag vom ${fmtDay(d.date)} entfernen">Entfernen</button></td></tr>`).join('')}</tbody>
        <tfoot><tr class="sum"><th scope="row">Summe</th><td></td><td class="num">${sum > 0 ? '+' : ''}${eur2(sum)}</td><td></td></tr></tfoot>`
      : '<tbody><tr><td class="muted">Noch keine Einzahlungen eingetragen.</td></tr></tbody>';
  }
  $('#form-deposit').addEventListener('submit', (e) => {
    e.preventDefault();
    const amount = centsOf($('#in-dep-amount').value);
    const date = $('#in-dep-date').value;
    const status = $('#dep-status');
    if (!(amount > 0)) { status.textContent = 'Bitte einen Betrag über 0 € eingeben.'; $('#in-dep-amount').focus(); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { status.textContent = 'Bitte ein Datum wählen.'; $('#in-dep-date').focus(); return; }
    const sign = $('#in-dep-type').value === '-1' ? -1 : 1;
    pf.deposits.push({ id: newId(), accountId: $('#in-dep-account').value, date, amountCents: sign * amount });
    // Ältere Tagesstände kennen die neue Einzahlung noch nicht; ihr Einzahlungsstand wird nachgezogen.
    for (const s of pf.snapshots) if (s.date >= date) s.depositsCents += sign * amount;
    $('#in-dep-amount').value = '';
    status.textContent = `${sign > 0 ? 'Einzahlung' : 'Entnahme'} von ${eur2(amount)} am ${fmtDay(date)} eingetragen.`;
    commit();
  });
  $('#table-deposits').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act="delDep"]');
    if (!b) return;
    const d = pf.deposits.find((x) => x.id === b.closest('[data-dep]').dataset.dep);
    pf.deposits = pf.deposits.filter((x) => x !== d);
    for (const s of pf.snapshots) if (s.date >= d.date) s.depositsCents -= d.amountCents;
    commit();
  });

  // ---------- Sicherung ----------

  function renderBackup() {
    const day = today();
    const last = pf.settings.lastBackup;
    $('#backup-note').innerHTML = backupDue(pf, day)
      ? note('warn', 'SICHERUNG', last ? `Die letzte Sicherung ist vom ${fmtDay(last)}, also älter als 30 Tage. Lade jetzt eine neue herunter und leg sie zum Beispiel in iCloud Drive ab.` : 'Du hast noch keine Sicherung. Lade eine herunter und leg sie zum Beispiel in iCloud Drive ab.')
      : last ? note('ok', 'AKTUELL', `Letzte Sicherung am ${fmtDay(last)}. Nach 30 Tagen erinnert dich die App.`) : '';
    $('#backup-last').textContent = `${pf.accounts.length} Konten, ${pf.holdings.length} Positionen, ${pf.debts.length} Schulden, ${pf.deposits.length} Einzahlungen, ${pf.snapshots.length} Tagesstände.`;
  }

  // ---------- Andere Tabs ----------

  window.addEventListener('storage', (e) => {
    if (e.key !== PORTFOLIO_KEY) return;
    pf = sanitizePortfolio(load(PORTFOLIO_KEY));
    commit();
  });

  return {
    /** Erster Aufruf beim Start: Tagesstand von heute, dann Kurse laden, wenn sie älter als eine Stunde sind. */
    start() { commit(); refreshQuotes(); },
    /** Nach Änderungen im Darlehen-Rechner (Darlehensbetrag als Schuld). */
    inputChanged() { commit(); },
    drawCharts,
    get: () => pf,
    hasData: () => pf.accounts.length > 0,
    /** Ersetzt den Bestand (Import). */
    replace(next) { pf = sanitizePortfolio(next); quoteFailed = []; commit(); refreshQuotes(); },
    markBackup() { pf.settings.lastBackup = today(); save(pf, PORTFOLIO_KEY); renderBackup(); renderOverview(); },
  };
}
