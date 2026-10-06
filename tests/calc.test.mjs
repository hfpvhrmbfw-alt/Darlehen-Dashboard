// Prüfwerte für den Rechenkern. Ausführen mit: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS, compare, monteCarlo, monthlyPayment, toModel, netValue, validate,
  fmtEur, fmtNum, quantile, breakEven, rng,
} from '../calc.js';

// Abweichung höchstens 1 %
function near(actual, expected, tol = 0.01, label = '') {
  const dev = Math.abs(actual - expected) / Math.abs(expected);
  assert.ok(dev <= tol, `${label}: ${actual} weicht ${(dev * 100).toFixed(2)} % von ${expected} ab (erlaubt ${(tol * 100).toFixed(2)} %)`);
}

const base = { ...DEFAULTS, loan: 20000, variant: 'A', term: 10, grace: 10, cryptoGrowth: 10 };

test('Darlehen 20.000 €, Variante A, Tilgung 10 Jahre, Krypto 10 %', () => {
  const r = compare(base);
  near(r.finalWithout, 586130, 0.01, 'Vermögen mit 60 ohne Darlehen');
  near(r.finalWith, 652505, 0.01, 'Vermögen mit 60 mit Darlehen');
  near(r.diff, 66376, 0.01, 'Unterschied');
  near(r.yearsWithout, 9.9, 0.01, 'Jahre bis 100.000 € ohne');
  near(r.yearsWith, 8.6, 0.01, 'Jahre bis 100.000 € mit');
});

test('Gleiche Einstellung mit Krypto 0 %', () => {
  const r = compare({ ...base, cryptoGrowth: 0 });
  near(r.finalWithout, 276881, 0.01, 'ohne Darlehen');
  near(r.finalWith, 343257, 0.01, 'mit Darlehen');
  near(r.yearsWithout, 14.7, 0.01, 'Jahre ohne');
  near(r.yearsWith, 11.8, 0.01, 'Jahre mit');
});

test('Darlehen 50.000 €, Tilgung 10 Jahre, Krypto 10 %', () => {
  const r = compare({ ...base, loan: 50000 });
  near(r.finalWith, 752069, 0.01, 'mit Darlehen');
  near(r.diff, 165939, 0.01, 'Unterschied');
  near(r.yearsWith, 7.1, 0.01, 'Jahre mit');
  near(r.payment, 417, 0.01, 'Rate');
  near(monthlyPayment(toModel({ ...base, loan: 50000 })), 416.67, 0.001, 'Rate exakt');
});

test('Simulation 20.000 €: Wahrscheinlichkeit ETF < Darlehen nach 10 Jahren etwa 12 %, Lücke im 5-%-Fall etwa 4.400 €', () => {
  const mc = monteCarlo(base);
  assert.equal(mc.runs, 20000);
  assert.ok(Math.abs(mc.probBelowLoan - 0.12) <= 0.015, `Wahrscheinlichkeit ${(mc.probBelowLoan * 100).toFixed(2)} % liegt nicht bei 12 % ± 1,5 Pp.`);
  near(mc.gapP5, 4400, 0.05, 'Lücke 5-%-Fall bei 20.000 €');
});

test('Simulation 50.000 €: Lücke im 5-%-Fall etwa 11.000 €', () => {
  const mc = monteCarlo({ ...base, loan: 50000 });
  assert.ok(Math.abs(mc.probBelowLoan - 0.12) <= 0.015, `Wahrscheinlichkeit ${(mc.probBelowLoan * 100).toFixed(2)} %`);
  near(mc.gapP5, 11000, 0.05, 'Lücke 5-%-Fall bei 50.000 €');
});

test('Simulation ist mit gesetztem Zufallswert reproduzierbar', () => {
  const a = monteCarlo(base, { runs: 2000 });
  const b = monteCarlo(base, { runs: 2000 });
  assert.equal(a.withLoan.median, b.withLoan.median);
  assert.equal(a.probBelowLoan, b.probBelowLoan);
});

test('Zinsgrenze: Median-Gewinn sinkt mit dem Zins und wird irgendwann negativ', () => {
  const mc = monteCarlo(base, { runs: 3000, rates: [0, 2, 4, 6, 8] });
  const med = mc.rates.map((r) => r.median);
  for (let j = 1; j < med.length; j++) assert.ok(med[j] < med[j - 1], 'Median-Gewinn fällt mit dem Zins');
  assert.ok(mc.breakEvenRate > 0 && mc.breakEvenRate < 8, `Zinsgrenze ${mc.breakEvenRate}`);
});

test('Variante B tilgt aus dem ETF und versteuert anteilig', () => {
  const r = compare({ ...base, variant: 'B' });
  assert.equal(r.withLoan.debt, 0, 'Darlehen am Ende getilgt');
  assert.ok(r.withLoan.taxPaid > 0, 'Steuern auf Verkäufe');
  const a = compare(base);
  assert.ok(r.withLoan.series[240].l < a.withLoan.series[240].l, 'Darlehens-Depot schrumpft durch Verkäufe');
  assert.ok(r.withLoan.series[240].e > a.withLoan.series[240].e, 'Sparrate läuft in Variante B weiter');
  const mc = monteCarlo({ ...base, variant: 'B' }, { runs: 2000 });
  assert.ok(mc.probLoanDepotShort >= 0 && mc.probLoanDepotShort <= 1);
});

test('Zinsen werden aus dem Einkommen bezahlt und senken das Ergebnis', () => {
  const r0 = compare(base), r3 = compare({ ...base, loanRate: 3 });
  assert.ok(r3.finalWith < r0.finalWith);
  // Referenz: Zinsen auf die jeweilige Restschuld, 10 Jahre voll, dann 120 Raten zu 166,67 €
  let ref = 0, debt = 20000;
  for (let k = 1; k <= 360; k++) { ref += debt * 0.03 / 12; if (k > 120 && debt > 0) debt -= 20000 / 120; }
  near(r3.withLoan.interestPaid, ref, 0.001, 'Zinsen gesamt');
  assert.equal(r3.finalWithout, r0.finalWithout, 'ohne Darlehen unverändert');
});

test('Netto-Ansicht: Gewinn wird mit 26,375 % auf 70 % versteuert', () => {
  const m = toModel(DEFAULTS);
  near(m.taxEff, 0.184625, 1e-9, 'effektiver Steuersatz');
  assert.equal(netValue(2000, 1000, m.taxEff), 2000 - 1000 * 0.184625);
  assert.equal(netValue(800, 1000, m.taxEff), 800);
});

test('Plausibilitätsprüfung meldet Tilgung über den Horizont hinaus', () => {
  assert.deepEqual(validate(DEFAULTS), []);
  const msgs = validate({ ...DEFAULTS, grace: 20, term: 20 });
  assert.ok(msgs.some((t) => t.includes('länger als der Horizont')));
});

test('Hilfsfunktionen: Format und Statistik', () => {
  assert.equal(fmtEur(1234.56, 2), '1.234,56 €');
  assert.equal(fmtNum(-0.0001, 1), '0,0');
  assert.equal(fmtNum(-1500, 0), '−1.500');
  assert.equal(quantile(Float64Array.from([1, 2, 3, 4, 5]), 0.5), 3);
  assert.equal(breakEven([{ rate: 0, median: 10 }, { rate: 1, median: -10 }]), 0.5);
  const r = rng(1); const x = r(); assert.ok(x >= 0 && x < 1);
});

// ---------- Rückzahlungsplan ----------
import { repaymentPlan, buildCustomPlan, monthDiff, addMonths } from '../calc.js';

test('Monatsrechnung: Abstand und Addition', () => {
  assert.equal(monthDiff('2026-10', '2036-11'), 121);
  assert.equal(addMonths('2026-10', 3), '2027-01');
  assert.equal(monthDiff('2026-10', 'Oktober'), null);
});

test('Standard-Plan: 120 Raten zu 166,67 € ab Monat 121', () => {
  const p = repaymentPlan({ ...base, refMonth: '2026-10' });
  assert.equal(p.count, 120);
  assert.equal(p.first, '2036-11');
  assert.equal(p.last, '2046-10');
  near(p.rows[0].pay, 166.67, 0.001, 'Rate');
  near(p.total, 20000, 1e-9, 'Summe');
  assert.equal(p.debtEnd, 0);
});

test('Einfacher Plan „…/Monat ab …“ entspricht dem Standard, wenn Betrag und Start gleich sind', () => {
  const std = compare({ ...base, refMonth: '2026-10' });
  const simple = compare({ ...base, refMonth: '2026-10', planMode: 'simple', planAmount: 20000 / 120, planStart: '2036-11' });
  near(simple.finalWith, std.finalWith, 1e-9, 'Vermögen mit Darlehen');
  const p = repaymentPlan({ ...base, refMonth: '2026-10', planMode: 'simple', planAmount: 500, planStart: '2030-01' });
  assert.equal(p.first, '2030-01');
  assert.equal(p.count, 40);
  assert.equal(p.last, '2033-04');
});

test('Individueller Plan: Monate einzeln, Restschuld und Warnung', () => {
  const rows = buildCustomPlan(20000, 1000, '2027-01');
  assert.equal(rows.length, 20);
  rows[0].a = 3000; // erster Monat mehr
  const p = repaymentPlan({ ...base, refMonth: '2026-10', planMode: 'custom', planCustom: rows });
  assert.equal(p.count, 18, 'nach 18 Monaten getilgt, weil der erste Monat mehr zahlt');
  near(p.rows[0].pay, 3000, 1e-9, 'erste Zahlung');
  const short = repaymentPlan({ ...base, refMonth: '2026-10', planMode: 'custom', planCustom: rows.slice(0, 5) });
  near(short.debtEnd, 20000 - 3000 - 4000, 1e-9, 'Restschuld');
  const msgs = validate({ ...base, refMonth: '2026-10', planMode: 'custom', planCustom: rows.slice(0, 5) });
  assert.ok(msgs.some((t) => t.includes('Restschuld')));
});

test('Variante B mit Plan: Verkauf aus dem ETF inklusive Steuer', () => {
  const p = repaymentPlan({ ...base, refMonth: '2026-10', variant: 'B' });
  assert.ok(p.taxTotal > 0);
  near(p.soldTotal - p.taxTotal, 20000, 1e-6, 'netto ausgezahlt = Darlehen');
});

test('Darlehensgeld schon investiert: heutiger Wert ersetzt den Darlehensbetrag im ETF', () => {
  const a = compare({ ...base, refMonth: '2026-10' });
  const b = compare({ ...base, refMonth: '2026-10', loanEtfNow: 22000 });
  near(b.finalWith - a.finalWith, 2000 * Math.pow(1.06, 30), 1e-6, 'Mehrwert wächst mit');
  assert.equal(b.finalWithout, a.finalWithout);
});
