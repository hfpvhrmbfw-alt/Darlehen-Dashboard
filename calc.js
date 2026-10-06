// Rechenkern des Darlehen-Trackers.
// Reine Funktionen ohne DOM, damit sie im Browser, im Web Worker und mit "node --test" laufen.
// Gedankenrechnung, keine Anlage-, Rechts- oder Steuerberatung.

export const DEFAULTS = Object.freeze({
  crypto: 18800,        // Krypto-Depot heute in €
  cryptoGrowth: 10,     // Wachstum Krypto pro Jahr in %
  etf: 11000,           // ETF-Bestand heute in €
  savings: 200,         // monatliche ETF-Sparrate in €
  etfReturn: 6,         // ETF-Rendite pro Jahr in %
  volatility: 16,       // Schwankung pro Jahr in %
  loan: 20000,          // Darlehensbetrag in €
  loanRate: 0,          // Darlehenszins pro Jahr in %
  grace: 10,            // tilgungsfreie Zeit in Jahren
  term: 10,             // Tilgungsdauer in Jahren (5, 10 oder 20)
  variant: 'A',         // A = Raten aus dem Einkommen, B = Raten durch Verkauf aus dem ETF
  ageNow: 30,           // Alter heute
  ageTarget: 60,        // Zielalter (Horizont = Zielalter − Alter heute)
  taxRate: 26.375,      // Steuer auf ETF-Gewinn in %
  exemption: 30,        // Teilfreistellung in %
  inflation: 2,         // Inflation pro Jahr in %
});

export const TARGET = 100000;
export const MC_RUNS = 20000;
export const MC_SEED = 20261006;

/** Wandelt die Eingaben (Prozentwerte) in Modellparameter (Dezimalwerte, Monate) um. */
export function toModel(input) {
  const p = { ...DEFAULTS, ...input };
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const horizonYears = Math.max(0, Math.round(num(p.ageTarget, 60) - num(p.ageNow, 30)));
  return {
    crypto: Math.max(0, num(p.crypto, 0)),
    g: num(p.cryptoGrowth, 0) / 100,
    etf: Math.max(0, num(p.etf, 0)),
    savings: Math.max(0, num(p.savings, 0)),
    r: num(p.etfReturn, 0) / 100,
    vol: Math.max(0, num(p.volatility, 0)) / 100,
    loan: Math.max(0, num(p.loan, 0)),
    i: Math.max(0, num(p.loanRate, 0)) / 100,
    graceMonths: Math.max(0, Math.round(num(p.grace, 0) * 12)),
    termMonths: Math.max(0, Math.round(num(p.term, 0) * 12)),
    variant: p.variant === 'B' ? 'B' : 'A',
    months: horizonYears * 12,
    horizonYears,
    // effektiver Steuersatz auf ETF-Gewinne: 26,375 % auf 70 % des Gewinns
    taxEff: (num(p.taxRate, 0) / 100) * (1 - num(p.exemption, 0) / 100),
    infl: num(p.inflation, 0) / 100,
  };
}

/** Monatliche Tilgungsrate in € (Darlehen / Laufzeit in Monaten). */
export function monthlyPayment(m, loan = m.loan) {
  return m.termMonths > 0 ? loan / m.termMonths : 0;
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
  const pay = monthlyPayment(m, loan);
  const factorAt = typeof factors === 'function' ? factors : (k) => factors[k];

  let c = m.crypto;
  let e = m.etf, eB = m.etf;       // eigenes Depot und Einstandswert
  let l = loan, lB = loan;         // Darlehensgeld im ETF und Einstandswert
  let debt = loan;
  let interestAcc = 0, interestPaid = 0, taxPaid = 0;
  let lAtGrace = m.graceMonths === 0 ? l : null;
  let loanDepotShort = false;      // Variante B: Darlehens-Depot reicht nicht zur Tilgung
  let depotShort = false;          // Variante B: ETF insgesamt reicht nicht zur Tilgung
  let t100 = null;
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
    taxPaid += tax;
    if (which === 'l') { l -= gross; lB -= B * share; } else { e -= gross; eB -= B * share; }
    return gross - tax;
  }
  function total() { return c + e + l - debt; }
  function snapshot(k) {
    const defl = Math.pow(1 + m.infl, k / 12);
    const gross = c + e + l - debt;
    const net = c + netValue(e, eB, taxEff) + netValue(l, lB, taxEff) - debt;
    return { month: k, c, e, l, debt, gross, net, real: gross / defl, realNet: net / defl };
  }

  for (let k = 1; k <= months; k++) {
    const f = factorAt(k - 1);
    c *= fc;
    e = e * f + m.savings;
    eB += m.savings;
    l *= f;

    // Zinsen laufen monatlich auf und werden jährlich aus dem Einkommen bezahlt.
    if (i > 0 && debt > 0) interestAcc += debt * i / 12;
    if (k % 12 === 0 && interestAcc > 0) { fromIncome(interestAcc); interestPaid += interestAcc; interestAcc = 0; }

    if (k === m.graceMonths) lAtGrace = l;

    if (k > m.graceMonths && debt > 0 && pay > 0) {
      const due = Math.min(pay, debt);
      if (m.variant === 'A') {
        fromIncome(due);
        debt -= due;
      } else {
        let paid = sell('l', due);
        if (paid < due - 1e-9) {
          loanDepotShort = true;
          paid += sell('e', due - paid);
          if (paid < due - 1e-9) depotShort = true;
        }
        debt -= paid;
      }
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
    interestPaid, taxPaid,
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

/** Plausibilitätsprüfung der Eingaben. Gibt eine Liste von Hinweistexten zurück. */
export function validate(input) {
  const p = { ...DEFAULTS, ...input };
  const m = toModel(p);
  const out = [];
  const fields = ['crypto', 'cryptoGrowth', 'etf', 'savings', 'etfReturn', 'volatility', 'loan', 'loanRate', 'grace', 'term', 'ageNow', 'ageTarget', 'taxRate', 'exemption', 'inflation'];
  for (const k of fields) {
    if (!Number.isFinite(Number(p[k]))) out.push(`Das Feld „${LABELS[k]}“ enthält keine gültige Zahl.`);
    else if (Number(p[k]) < 0) out.push(`Das Feld „${LABELS[k]}“ ist negativ; gerechnet wird mit 0.`);
  }
  if (m.horizonYears <= 0) out.push('Das Zielalter muss über dem heutigen Alter liegen, sonst gibt es keinen Horizont.');
  if (m.loan > 0 && m.termMonths === 0) out.push('Die Tilgungsdauer ist 0 Jahre; das Darlehen würde nie getilgt.');
  if (m.loan > 0 && m.horizonYears > 0 && m.graceMonths + m.termMonths > m.months) {
    const y = (mo) => fmtNum(mo / 12, mo % 12 ? 1 : 0);
    out.push(`Tilgungsfreie Zeit (${y(m.graceMonths)} J.) und Tilgung (${y(m.termMonths)} J.) dauern länger als der Horizont (${m.horizonYears} J.); am Ende bleibt eine Restschuld.`);
  }
  if (m.loan > 0 && m.variant === 'A' && monthlyPayment(m) > m.savings) {
    out.push(`Die Rate von ${fmtNum(monthlyPayment(m), 0)} € ist höher als die Sparrate von ${fmtNum(m.savings, 0)} €. In Variante A muss die Differenz zusätzlich aus dem Einkommen kommen; das Modell zieht sie vom eigenen Depot ab.`);
  }
  if (m.exemption > 1 || Number(p.exemption) > 100) out.push('Die Teilfreistellung kann nicht über 100 % liegen.');
  if (Number(p.taxRate) > 100) out.push('Der Steuersatz kann nicht über 100 % liegen.');
  if (Number(p.etfReturn) < 3 || Number(p.etfReturn) > 9) out.push('Die ETF-Rendite liegt außerhalb der vorgesehenen Spanne von 3 bis 9 %.');
  if (Number(p.volatility) > 60) out.push('Eine Schwankung über 60 % pro Jahr ist für einen Welt-ETF unrealistisch.');
  return out;
}

export const LABELS = {
  crypto: 'Krypto-Depot heute', cryptoGrowth: 'Wachstum Krypto pro Jahr', etf: 'ETF-Bestand heute',
  savings: 'Monatliche ETF-Sparrate', etfReturn: 'ETF-Rendite pro Jahr', volatility: 'Schwankung',
  loan: 'Darlehen', loanRate: 'Darlehenszins', grace: 'Tilgungsfreie Zeit', term: 'Tilgung über',
  ageNow: 'Alter heute', ageTarget: 'Zielalter', taxRate: 'Steuer auf ETF-Gewinn',
  exemption: 'Teilfreistellung', inflation: 'Inflation',
};

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
    let lg = m.loan;
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

// ---------- Format ----------

const nfCache = new Map();
export function fmtNum(v, digits = 0) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  const key = digits;
  if (!nfCache.has(key)) nfCache.set(key, new Intl.NumberFormat('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  let r = Math.round(v * 10 ** digits) / 10 ** digits;
  if (r === 0) r = 0; // keine „−0“
  return nfCache.get(key).format(r).replace('-', '−');
}
export function fmtEur(v, digits = 0) { return Number.isFinite(v) ? `${fmtNum(v, digits)} €` : '–'; }
export function fmtPct(v, digits = 1) { return Number.isFinite(v) ? `${fmtNum(v * 100, digits)} %` : '–'; }
export function fmtYears(v, digits = 1) { return v === null || !Number.isFinite(v) ? 'nicht erreicht' : `${fmtNum(v, digits)} J.`; }
