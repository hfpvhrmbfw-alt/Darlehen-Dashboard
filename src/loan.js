// Rechenkern des Darlehen-Rechners.
// Reine Funktionen ohne DOM, Speicher und Uhr, damit sie im Browser, im Web Worker und mit "node --test" laufen.
// Ergebnisse sind Daten (Zahlen, Codes), keine Anzeigetexte. Gedankenrechnung, keine Anlage-, Rechts- oder Steuerberatung.

import { DEFAULTS } from './model.js';
export { DEFAULTS };

/** Monat eines Datums als "JJJJ-MM". Das Datum ("heute") übergibt die Oberfläche. */
export function currentMonth(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
/** Monate von ref bis target (beide "JJJJ-MM"); null bei ungültiger Eingabe. */
export function monthDiff(ref, target) {
  const re = /^(\d{4})-(\d{2})$/;
  const a = re.exec(String(ref || '')), b = re.exec(String(target || ''));
  if (!a || !b) return null;
  return (Number(b[1]) - Number(a[1])) * 12 + (Number(b[2]) - Number(a[2]));
}
/** "JJJJ-MM" plus k Monate. */
export function addMonths(ref, k) {
  const [y, mo] = ref.split('-').map(Number);
  const t = y * 12 + (mo - 1) + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

export const TARGET = 100000;
export const MC_RUNS = 20000;
export const MC_SEED = 20261006;

/** Wandelt die Eingaben (Prozentwerte) in Modellparameter (Dezimalwerte, Monate) um. */
export function toModel(input) {
  const p = { ...DEFAULTS, ...input };
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const horizonYears = Math.max(0, Math.round(num(p.ageTarget, 60) - num(p.ageNow, 30)));
  const loan = Math.max(0, num(p.loan, 0));
  // Bezugsmonat "heute" kommt von außen; ohne ihn sind nur Pläne mit Kalendermonaten nicht rechenbar.
  const ref = /^\d{4}-\d{2}$/.test(String(p.refMonth || '')) ? p.refMonth : null;
  let graceMonths = Math.max(0, Math.round(num(p.grace, 0) * 12));
  const termMonths = Math.max(0, Math.round(num(p.term, 0) * 12));
  // Rückzahlungsplan als Liste von Monatsbeträgen (Index k = Monate ab heute) oder Regel
  let plan = { mode: 'standard' };
  if (p.planMode === 'simple') {
    const k0 = p.planStart ? monthDiff(ref, p.planStart) : graceMonths + 1;
    const start = Math.max(1, k0 === null ? graceMonths + 1 : k0);
    plan = { mode: 'simple', start, amount: Math.max(0, num(p.planAmount, 0)) };
    graceMonths = start - 1;
  } else if (p.planMode === 'custom') {
    const amounts = new Map();
    let past = 0;
    for (const row of Array.isArray(p.planCustom) ? p.planCustom : []) {
      const k = monthDiff(ref, row && row.m);
      const a = Math.max(0, num(row && row.a, 0));
      if (k === null || a <= 0) continue;
      if (k < 1) { past++; continue; }
      amounts.set(k, (amounts.get(k) || 0) + a);
    }
    const first = amounts.size ? Math.min(...amounts.keys()) : null;
    plan = { mode: 'custom', amounts, first, past };
    if (first !== null) graceMonths = first - 1;
  }
  return {
    ref, plan,
    crypto: Math.max(0, num(p.crypto, 0)),
    g: num(p.cryptoGrowth, 0) / 100,
    etf: Math.max(0, num(p.etf, 0)),
    savings: Math.max(0, num(p.savings, 0)),
    r: num(p.etfReturn, 0) / 100,
    vol: Math.max(0, num(p.volatility, 0)) / 100,
    loan,
    loanEtfNow: Math.max(0, num(p.loanEtfNow, 0)),
    i: Math.max(0, num(p.loanRate, 0)) / 100,
    graceMonths,
    termMonths,
    variant: p.variant === 'B' ? 'B' : 'A',
    months: horizonYears * 12,
    horizonYears,
    // effektiver Steuersatz auf ETF-Gewinne: 26,375 % auf 70 % des Gewinns
    taxEff: (num(p.taxRate, 0) / 100) * (1 - num(p.exemption, 0) / 100),
    infl: num(p.inflation, 0) / 100,
  };
}

/** Monatliche Tilgungsrate in €: Standard = Darlehen / Laufzeit, einfacher Plan = Betrag, individuell = erste Rate. */
export function monthlyPayment(m, loan = m.loan) {
  if (!m.plan || m.plan.mode === 'standard') return m.termMonths > 0 ? loan / m.termMonths : 0;
  if (loan <= 0) return 0;
  if (m.plan.mode === 'simple') return m.plan.amount;
  return m.plan.first === null ? 0 : m.plan.amounts.get(m.plan.first);
}

/** Fällige Zahlung im Monat k laut Plan (vor Begrenzung auf die Restschuld). */
export function dueAt(m, k, loan = m.loan) {
  if (loan <= 0) return 0;
  const plan = m.plan || { mode: 'standard' };
  if (plan.mode === 'standard') return k > m.graceMonths && m.termMonths > 0 ? loan / m.termMonths : 0;
  if (plan.mode === 'simple') return k >= plan.start ? plan.amount : 0;
  return plan.amounts.get(k) || 0;
}

/** Netto-Wert eines ETF-Depots: Gewinn über dem Einstandswert wird versteuert. */
export function netValue(value, basis, taxEff) {
  const gain = value - basis;
  return gain > 0 ? value - gain * taxEff : value;
}

/**
 * Kern-Simulation in Monatsschritten.
 * factors: Array (oder Funktion m -> Faktor) der monatlichen ETF-Wachstumsfaktoren.
 * opts.loan: Darlehensbetrag (0 = ohne Darlehen), opts.i: Zins, opts.record: Monatsreihe speichern.
 */
export function engine(m, factors, opts = {}) {
  const loan = opts.loan ?? m.loan;
  const i = opts.i ?? m.i;
  const months = opts.months ?? m.months;
  const record = !!opts.record;
  const taxEff = m.taxEff;
  const fc = Math.pow(1 + m.g, 1 / 12);
  const factorAt = typeof factors === 'function' ? factors : (k) => factors[k];

  let c = m.crypto;
  let e = m.etf, eB = m.etf;       // eigenes Depot und Einstandswert
  // Darlehensgeld im ETF (ggf. heutiger Wert, wenn schon investiert) und Einstandswert
  let l = loan > 0 && loan === m.loan && m.loanEtfNow > 0 ? m.loanEtfNow : loan, lB = loan;
  let debt = loan;
  let interestAcc = 0, interestPaid = 0, taxPaid = 0;
  let lAtGrace = m.graceMonths === 0 ? l : null;
  let loanDepotShort = false;      // Variante B: Darlehens-Depot reicht nicht zur Tilgung
  let depotShort = false;          // Variante B: ETF insgesamt reicht nicht zur Tilgung
  let t100 = null;
  let payNow = 0, soldNow = 0, taxNow = 0, paidTotal = 0, lastPayMonth = null;
  const series = record ? [snapshot(0)] : null;
  if (record && total() >= TARGET) t100 = 0;

  // Abzug aus dem Einkommen: fehlt in der Sparrate, verringert also das eigene Depot.
  function fromIncome(x) {
    if (e > 0) eB -= eB * Math.min(1, x / e);
    e -= x;
    if (eB < 0) eB = 0;
  }
  // Verkauf aus einem Depot, sodass netto `need` übrig bleibt. Gibt den netto erzielten Betrag zurück.
  function sell(which, need) {
    const V = which === 'l' ? l : e;
    const B = which === 'l' ? lB : eB;
    if (V <= 0 || need <= 0) return 0;
    const gainFrac = V > B ? (V - B) / V : 0;
    const netPerEuro = 1 - gainFrac * taxEff;
    let gross = need / netPerEuro;
    if (gross > V) gross = V;
    const share = gross / V;
    const tax = gross * gainFrac * taxEff;
    taxPaid += tax; taxNow += tax; soldNow += gross;
    if (which === 'l') { l -= gross; lB -= B * share; } else { e -= gross; eB -= B * share; }
    return gross - tax;
  }
  function total() { return c + e + l - debt; }
  function snapshot(k) {
    const defl = Math.pow(1 + m.infl, k / 12);
    const gross = c + e + l - debt;
    const net = c + netValue(e, eB, taxEff) + netValue(l, lB, taxEff) - debt;
    return { month: k, c, e, l, debt, gross, net, real: gross / defl, realNet: net / defl, pay: payNow, sold: soldNow, tax: taxNow };
  }

  for (let k = 1; k <= months; k++) {
    const f = factorAt(k - 1);
    payNow = 0; soldNow = 0; taxNow = 0;
    c *= fc;
    e = e * f + m.savings;
    eB += m.savings;
    l *= f;

    // Zinsen laufen monatlich auf und werden jährlich aus dem Einkommen bezahlt.
    if (i > 0 && debt > 0) interestAcc += debt * i / 12;
    if (k % 12 === 0 && interestAcc > 0) { fromIncome(interestAcc); interestPaid += interestAcc; interestAcc = 0; }

    if (k === m.graceMonths) lAtGrace = l;

    const planned = debt > 0 ? dueAt(m, k, loan) : 0;
    if (planned > 0) {
      const due = Math.min(planned, debt);
      if (m.variant === 'A') {
        fromIncome(due);
        debt -= due;
        payNow = due;
      } else {
        let paid = sell('l', due);
        if (paid < due - 1e-9) {
          loanDepotShort = true;
          paid += sell('e', due - paid);
          if (paid < due - 1e-9) depotShort = true;
        }
        debt -= paid;
        payNow = paid;
      }
      if (payNow > 0) { paidTotal += payNow; lastPayMonth = k; }
      if (debt < 1e-9) debt = 0;
    }

    if (t100 === null && c + e + l - debt >= TARGET) t100 = k;
    if (record) series.push(snapshot(k));
  }
  if (interestAcc > 0) { fromIncome(interestAcc); interestPaid += interestAcc; }

  return {
    final: total(),
    finalNet: c + netValue(e, eB, taxEff) + netValue(l, lB, taxEff) - debt,
    c, e, l, debt, eB, lB,
    lAtGrace: lAtGrace ?? l,
    t100,
    interestPaid, taxPaid, paidTotal, lastPayMonth,
    loanDepotShort, depotShort,
    series,
  };
}

/** Deterministische Rechnung mit fester Rendite r. */
export function simulate(input, opts = {}) {
  const m = toModel(input);
  const f = Math.pow(1 + m.r, 1 / 12);
  return engine(m, () => f, opts);
}

/** Wert eines Monatspunkts je nach Ansicht. */
export function pick(pt, view = {}) {
  const net = view.net, real = view.real;
  if (net && real) return pt.realNet;
  if (net) return pt.net;
  if (real) return pt.real;
  return pt.gross;
}

/** Erster Monat, in dem der Wert >= Ziel ist (in der gewählten Ansicht); null, wenn nie. */
export function monthsTo(series, target = TARGET, view = {}) {
  for (const pt of series) if (pick(pt, view) >= target) return pt.month;
  return null;
}

/** Vergleich ohne/mit Darlehen in der gewählten Ansicht. */
export function compare(input, view = {}) {
  const m = toModel(input);
  const f = Math.pow(1 + m.r, 1 / 12);
  const without = engine(m, () => f, { loan: 0, i: 0, record: true });
  const withLoan = engine(m, () => f, { record: true });
  const last = (s) => pick(s[s.length - 1], view);
  const a = last(without.series), b = last(withLoan.series);
  const t0 = monthsTo(without.series, TARGET, view);
  const t1 = monthsTo(withLoan.series, TARGET, view);
  return {
    model: m,
    without, withLoan,
    finalWithout: a,
    finalWith: b,
    diff: b - a,
    yearsWithout: t0 === null ? null : t0 / 12,
    yearsWith: t1 === null ? null : t1 / 12,
    payment: monthlyPayment(m),
    interestMonthly: m.loan * m.i / 12,
  };
}

/** Jahre bis zu mehreren Zielwerten (brutto, nominal), mit Darlehen; Suche bis maxYears. */
export function milestones(input, targets, maxYears = 70) {
  const m = toModel(input);
  const f = Math.pow(1 + m.r, 1 / 12);
  const res = engine(m, () => f, { record: true, months: maxYears * 12 });
  return targets.map((t) => {
    const k = monthsTo(res.series, t);
    return k === null ? null : k / 12;
  });
}

/**
 * Plausibilitätsprüfung der Eingaben.
 * @returns {Array<{code: string, field?: string, [k: string]: number|string}>} Befunde als Codes mit Werten; Texte baut die Oberfläche.
 */
export function validate(input) {
  const p = { ...DEFAULTS, ...input };
  const m = toModel(p);
  const out = [];
  const fields = ['crypto', 'cryptoGrowth', 'etf', 'savings', 'etfReturn', 'volatility', 'loan', 'loanRate', 'grace', 'term', 'ageNow', 'ageTarget', 'taxRate', 'exemption', 'inflation'];
  for (const k of fields) {
    if (!Number.isFinite(Number(p[k]))) out.push({ code: 'not-a-number', field: k });
    else if (Number(p[k]) < 0) out.push({ code: 'negative', field: k });
  }
  if (m.horizonYears <= 0) out.push({ code: 'no-horizon' });
  const std = m.plan.mode === 'standard';
  if (std && m.loan > 0 && m.termMonths === 0) out.push({ code: 'term-zero' });
  if (std && m.loan > 0 && m.horizonYears > 0 && m.graceMonths + m.termMonths > m.months) {
    out.push({ code: 'plan-exceeds-horizon', graceMonths: m.graceMonths, termMonths: m.termMonths, horizonYears: m.horizonYears });
  }
  if (m.loan > 0 && m.variant === 'A' && monthlyPayment(m) > m.savings) {
    out.push({ code: 'payment-over-savings', payment: monthlyPayment(m), savings: m.savings });
  }
  if (!std && m.loan > 0) {
    if (m.plan.mode === 'simple') {
      if (p.planStart && monthDiff(m.ref, p.planStart) === null) out.push({ code: 'plan-start-invalid' });
      else if (p.planStart && monthDiff(m.ref, p.planStart) < 1) out.push({ code: 'plan-start-past' });
      if (m.plan.amount <= 0) out.push({ code: 'plan-amount-zero' });
    } else {
      if (m.plan.first === null) out.push({ code: 'plan-custom-empty' });
      if (m.plan.past > 0) out.push({ code: 'plan-custom-past', count: m.plan.past });
      let sum = 0;
      for (const a of m.plan.amounts.values()) sum += a;
      if (sum > m.loan + 0.5) out.push({ code: 'plan-custom-over', sum, loan: m.loan });
    }
    const plan = repaymentPlan(p);
    if (m.horizonYears > 0 && plan.debtEnd > 0.5) out.push({ code: 'plan-debt-left', horizonYears: m.horizonYears, debt: plan.debtEnd });
  }
  if (m.exemption > 1 || Number(p.exemption) > 100) out.push({ code: 'exemption-over-100' });
  if (Number(p.taxRate) > 100) out.push({ code: 'tax-over-100' });
  if (Number(p.etfReturn) < 3 || Number(p.etfReturn) > 9) out.push({ code: 'return-out-of-range' });
  if (Number(p.volatility) > 60) out.push({ code: 'volatility-unrealistic' });
  return out;
}

/**
 * Rückzahlungsplan (deterministisch, feste Rendite): alle Monate mit Zahlung an die Eltern.
 * Zeilen: Monat ("JJJJ-MM"), Zahlung, bei Variante B verkaufter Betrag und Steuer, Restschuld danach.
 */
export function repaymentPlan(input) {
  const m = toModel(input);
  const f = Math.pow(1 + m.r, 1 / 12);
  const res = engine(m, () => f, { record: true });
  const rows = [];
  for (const pt of res.series) {
    if (pt.pay > 0) rows.push({ k: pt.month, month: m.ref ? addMonths(m.ref, pt.month) : null, pay: pt.pay, sold: pt.sold, tax: pt.tax, debt: pt.debt });
  }
  const total = rows.reduce((s, r) => s + r.pay, 0);
  return {
    ref: m.ref, variant: m.variant, loan: m.loan, mode: m.plan.mode,
    rows, total,
    first: rows.length ? rows[0].month : null,
    last: rows.length ? rows[rows.length - 1].month : null,
    count: rows.length,
    typical: monthlyPayment(m),
    debtEnd: res.debt,
    taxTotal: rows.reduce((s, r) => s + r.tax, 0),
    soldTotal: rows.reduce((s, r) => s + r.sold, 0),
  };
}

/** Erzeugt einen individuellen Plan aus einer einfachen Regel (Betrag pro Monat ab Startmonat, bis zur Tilgung). */
export function buildCustomPlan(loan, amount, startMonth, maxMonths = 600) {
  const rows = [];
  if (!(amount > 0) || !(loan > 0) || monthDiff(startMonth, startMonth) === null) return rows;
  let rest = loan;
  for (let k = 0; rest > 0.005 && k < maxMonths; k++) {
    const a = Math.min(amount, rest);
    rows.push({ m: addMonths(startMonth, k), a: Math.round(a * 100) / 100 });
    rest -= a;
  }
  return rows;
}

// ---------- Monte-Carlo ----------

/** Zufallszahlengenerator mit Startwert (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standardnormalverteilte Zufallszahlen (Box-Muller). */
export function normals(rand) {
  let spare = null;
  return function () {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0;
    while (u === 0) u = rand();
    const v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

/** Perzentil (q zwischen 0 und 1) einer sortierten Liste, linear interpoliert. */
export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function sortNum(arr) { return Float64Array.from(arr).sort(); }

/**
 * Monte-Carlo-Simulation der ETF-Renditen (logarithmische Normalverteilung der Monatsrenditen,
 * mu = ln(1 + r)/12, sigma = Schwankung/sqrt(12)). Krypto wird deterministisch gerechnet.
 * opts.rates: Liste von Darlehenszinsen in % für die Zinsgrenze.
 */
export function monteCarlo(input, opts = {}) {
  const m = toModel(input);
  const runs = opts.runs ?? MC_RUNS;
  const seed = opts.seed ?? MC_SEED;
  const rates = opts.rates ?? [];
  const bins = opts.bins ?? 30;
  const onProgress = opts.onProgress;
  const months = Math.max(m.months, m.graceMonths);
  const mu = Math.log(1 + m.r) / 12;
  const sigma = m.vol / Math.sqrt(12);
  const z = normals(rng(seed));
  const fac = new Float64Array(months);
  const facFn = (k) => fac[k];

  const finWithout = new Float64Array(runs);
  const finWith = new Float64Array(runs);
  const gain = new Float64Array(runs);
  const lGrace = new Float64Array(runs);
  let below = 0, loss = 0, loanShort = 0, depotShort = 0;
  const rateGains = rates.map(() => new Float64Array(runs));

  const mm = { ...m, months };
  for (let n = 0; n < runs; n++) {
    for (let k = 0; k < months; k++) fac[k] = Math.exp(mu + sigma * z());
    const a = engine(mm, facFn, { loan: 0, i: 0, months: m.months });
    const b = engine(mm, facFn, { months: m.months });
    finWithout[n] = a.final;
    finWith[n] = b.final;
    gain[n] = b.final - a.final;
    if (gain[n] < 0) loss++;
    // Darlehensgeld nach der tilgungsfreien Zeit (ohne Tilgung, daher eigene Rechnung)
    let lg = m.loan > 0 && m.loanEtfNow > 0 ? m.loanEtfNow : m.loan;
    for (let k = 0; k < m.graceMonths; k++) lg *= fac[k];
    lGrace[n] = lg;
    if (lg < m.loan) below++;
    if (b.loanDepotShort) loanShort++;
    if (b.depotShort) depotShort++;
    for (let j = 0; j < rates.length; j++) {
      const bj = engine(mm, facFn, { months: m.months, i: rates[j] / 100 });
      rateGains[j][n] = bj.final - a.final;
    }
    if (onProgress && (n + 1) % 2000 === 0) onProgress((n + 1) / runs);
  }

  const sW = sortNum(finWithout), sL = sortNum(finWith), sG = sortNum(gain), sLG = sortNum(lGrace);
  const p5Grace = quantile(sLG, 0.05);
  const result = {
    runs, seed,
    graceYears: m.graceMonths / 12,
    horizonYears: m.horizonYears,
    loan: m.loan,
    without: { median: quantile(sW, 0.5), p5: quantile(sW, 0.05), p95: quantile(sW, 0.95) },
    withLoan: { median: quantile(sL, 0.5), p5: quantile(sL, 0.05), p95: quantile(sL, 0.95) },
    gain: { median: quantile(sG, 0.5), p5: quantile(sG, 0.05), p95: quantile(sG, 0.95) },
    loanEtfAtGrace: { median: quantile(sLG, 0.5), p5: p5Grace },
    probBelowLoan: m.loan > 0 ? below / runs : 0,
    gapP5: m.loan > 0 ? Math.max(0, m.loan - p5Grace) : 0,
    probLoss: m.loan > 0 ? loss / runs : 0,
    probLoanDepotShort: m.variant === 'B' && m.loan > 0 ? loanShort / runs : null,
    probDepotShort: m.variant === 'B' && m.loan > 0 ? depotShort / runs : null,
    histogram: histogram(sL, bins),
    rates: rates.map((rate, j) => {
      const s = sortNum(rateGains[j]);
      let neg = 0;
      for (let n = 0; n < runs; n++) if (rateGains[j][n] < 0) neg++;
      return { rate, median: quantile(s, 0.5), p5: quantile(s, 0.05), probLoss: m.loan > 0 ? neg / runs : 0 };
    }),
  };
  result.breakEvenRate = breakEven(result.rates);
  return result;
}

/** Histogramm über das 1.–99. Perzentil einer sortierten Liste. */
export function histogram(sorted, bins = 30) {
  const lo = quantile(sorted, 0.01), hi = quantile(sorted, 0.99);
  const width = (hi - lo) / bins || 1;
  const counts = new Array(bins).fill(0);
  let under = 0, over = 0;
  for (const v of sorted) {
    if (v < lo) { under++; continue; }
    if (v > hi) { over++; continue; }
    counts[Math.min(bins - 1, Math.floor((v - lo) / width))]++;
  }
  return { lo, hi, width, counts, under, over, median: quantile(sorted, 0.5), p5: quantile(sorted, 0.05) };
}

/** Zinsgrenze: Zinssatz, ab dem der Median-Gewinn unter null fällt (linear interpoliert). */
export function breakEven(rows) {
  if (!rows.length) return null;
  if (rows[0].median < 0) return rows[0].rate;
  for (let j = 1; j < rows.length; j++) {
    const a = rows[j - 1], b = rows[j];
    if (b.median < 0) return a.rate + (b.rate - a.rate) * (a.median / (a.median - b.median));
  }
  return null;
}
