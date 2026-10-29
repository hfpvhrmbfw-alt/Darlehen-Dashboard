// Vermögen: Werte, Summen, Tagesstände, Zeitraum und Rendite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyPortfolio, sanitizePortfolio } from '../src/model.js';
import {
  holdingValue, totals, makeSnapshot, upsertSnapshot, periodChange, series, rangeStart,
  allocationCompare, staleSymbols, staleCurrencies, backupDue, seedFromCalculator, dayNumber, dayString, addDays,
} from '../src/portfolio.js';

function sample() {
  const pf = emptyPortfolio();
  pf.accounts = [{ id: 'a1', name: 'Depot' }, { id: 'a2', name: 'Tagesgeld' }];
  pf.holdings = [
    { id: 'h1', accountId: 'a1', name: 'All-World', kind: 'etf', symbol: 'VWCE.DE', quantity: 100, valueCents: null },
    { id: 'h2', accountId: 'a1', name: 'US-Aktie', kind: 'aktie', symbol: 'AAPL', quantity: 10, valueCents: null },
    { id: 'h3', accountId: 'a2', name: 'Tagesgeld', kind: 'cash', symbol: null, quantity: null, valueCents: 500000 },
    { id: 'h4', accountId: 'a2', name: 'Unbekannt', kind: 'sonstiges', symbol: null, quantity: null, valueCents: null },
  ];
  pf.prices = {
    'VWCE.DE': { price: 120.5, currency: 'EUR', fetchedAt: '2026-10-29T10:00:00.000Z' },
    AAPL: { price: 200, currency: 'USD', fetchedAt: '2026-10-29T10:00:00.000Z' },
  };
  pf.fx = { USD: { rate: 0.9, fetchedAt: '2026-10-29T10:00:00.000Z' } };
  pf.debts = [{ id: 'd1', name: 'Kredit', amountCents: 100000 }];
  return pf;
}

test('Tage: Hin- und Rückrechnung, Monatsende, Zeitraumbeginn', () => {
  for (let n = -800; n < 60000; n += 7) assert.equal(dayNumber(dayString(n)), n);
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(rangeStart('1M', '2026-03-31'), '2026-02-28');
  assert.equal(rangeStart('3M', '2026-10-29'), '2026-07-29');
  assert.equal(rangeStart('YTD', '2026-10-29'), '2026-01-01');
  assert.equal(rangeStart('1J', '2024-02-29'), '2023-02-28');
  assert.equal(rangeStart('MAX', '2026-10-29'), null);
});

test('Wert einer Position: Kurs × Anteile, Fremdwährung, manuell, fehlt', () => {
  const pf = sample();
  assert.deepEqual(holdingValue(pf.holdings[0], pf.prices, pf.fx), { cents: 1205000, source: 'kurs', currency: 'EUR' });
  assert.deepEqual(holdingValue(pf.holdings[1], pf.prices, pf.fx), { cents: 180000, source: 'kurs', currency: 'USD' });
  assert.deepEqual(holdingValue(pf.holdings[2], pf.prices, pf.fx), { cents: 500000, source: 'manuell', currency: 'EUR' });
  assert.deepEqual(holdingValue(pf.holdings[3], pf.prices, pf.fx), { cents: null, source: 'fehlt', currency: null });
  assert.equal(holdingValue(pf.holdings[1], pf.prices, {}).source, 'fehlt', 'ohne Wechselkurs kein Wert');
});

test('Summen: Anlagen, Schulden inkl. Darlehen, Aufteilung, Reihenfolge', () => {
  const t = totals(sample(), 2000000);
  assert.equal(t.assetsCents, 1205000 + 180000 + 500000);
  assert.equal(t.debtCents, 100000 + 2000000);
  assert.equal(t.netCents, 1885000 - 2100000);
  assert.equal(t.byKind.etf, 1205000);
  assert.equal(t.liquidCents, 500000);
  assert.equal(t.missing, 1);
  assert.deepEqual(t.rows.map((r) => r.holdingId), ['h1', 'h3', 'h2', 'h4']);
  assert.ok(Math.abs(t.rows[0].share - 1205000 / 1885000) < 1e-12);
});

test('Tagesstände: ersetzen am selben Tag, Veränderung ohne Einzahlungen, Rendite', () => {
  const pf = sample();
  pf.deposits = [{ id: 'e1', accountId: 'a1', date: '2026-09-15', amountCents: 100000 }];
  let list = [];
  const snap = (date, assets) => ({ date, assetsCents: assets, debtCents: 0, depositsCents: date >= '2026-09-15' ? 100000 : 0, byKind: { etf: assets, aktie: 0, krypto: 0, anleihe: 0, cash: 0, sonstiges: 0 } });
  list = upsertSnapshot(list, snap('2026-08-01', 1000000));
  list = upsertSnapshot(list, snap('2026-10-29', 1150000));
  list = upsertSnapshot(list, snap('2026-09-20', 1100000));
  list = upsertSnapshot(list, snap('2026-10-29', 1200000));
  assert.deepEqual(list.map((s) => s.date), ['2026-08-01', '2026-09-20', '2026-10-29']);
  const c = periodChange(list, '3M', '2026-10-29');
  assert.equal(c.from, '2026-08-01');
  assert.equal(c.diffCents, 200000);
  assert.equal(c.depositsCents, 100000);
  assert.equal(c.gainCents, 100000);
  assert.ok(Math.abs(c.returnRate - 100000 / 1050000) < 1e-12);
  const c1 = periodChange(list, '1M', '2026-10-29');
  assert.equal(c1.from, '2026-09-20', 'letzter Stand vor Zeitraumbeginn');
  assert.deepEqual(series(list, '1M', '2026-10-29').map((p) => p.date), ['2026-09-20', '2026-10-29']);
  assert.equal(periodChange([], '3M', '2026-10-29').diffCents, null);
  assert.equal(periodChange([list[2]], '3M', '2026-10-29').returnRate, null, 'ein einziger Stand: keine Rendite');
  const s = makeSnapshot(pf, '2026-10-29', 0);
  assert.equal(s.depositsCents, 100000);
  assert.equal(s.assetsCents, 1885000);
});

test('Aufteilung heute und vor einem Monat', () => {
  const list = [{ date: '2026-09-01', byKind: { etf: 1 } }, { date: '2026-09-30', byKind: { etf: 2 } }, { date: '2026-10-20', byKind: { etf: 3 } }];
  const a = allocationCompare(list, '2026-10-29', { etf: 4 });
  assert.equal(a.beforeDate, '2026-09-01');
  assert.deepEqual(a.before, { etf: 1 });
  assert.equal(allocationCompare([], '2026-10-29', {}).before, null);
});

test('Kurse: veraltet nach einer Stunde, Wechselkurse, Sicherung fällig', () => {
  const pf = sample();
  const now = Date.parse('2026-10-29T10:30:00.000Z');
  assert.deepEqual(staleSymbols(pf, now), []);
  assert.deepEqual(staleSymbols(pf, now + 3600000), ['VWCE.DE', 'AAPL']);
  pf.holdings.push({ id: 'h5', accountId: 'a1', name: 'Neu', kind: 'etf', symbol: 'EUNL.DE', quantity: 1, valueCents: null });
  assert.deepEqual(staleSymbols(pf, now), ['EUNL.DE']);
  assert.deepEqual(staleCurrencies(pf, now), []);
  assert.deepEqual(staleCurrencies(pf, now + 7200000), ['USD']);
  assert.equal(backupDue(emptyPortfolio(), '2026-10-29'), false);
  assert.equal(backupDue(pf, '2026-10-29'), true);
  pf.settings.lastBackup = '2026-10-01';
  assert.equal(backupDue(pf, '2026-10-29'), false);
  assert.equal(backupDue(pf, '2026-11-01'), true);
});

test('Übernahme aus dem Darlehen-Rechner', () => {
  let n = 0;
  const id = () => `id${++n}`;
  const seed = seedFromCalculator({ etf: 11000, etfShares: 80, etfSymbol: 'vwce.de', loan: 0, loanShares: 0, loanEtfNow: 0, crypto: 18800 }, id);
  assert.deepEqual(seed.accounts.map((a) => a.name), ['ETF-Depot', 'Krypto']);
  const withLoan = seedFromCalculator({ etf: 0, etfShares: 0, loan: 20000, loanShares: 0, loanEtfNow: 0, crypto: 0 }, id);
  assert.deepEqual(withLoan.accounts.map((a) => a.name), ['Darlehens-Depot'], 'nicht investiert: Darlehensbetrag zählt');
  assert.equal(withLoan.holdings[0].valueCents, 2000000);
  assert.deepEqual(seed.holdings[0], { id: 'id2', accountId: 'id1', name: 'VWCE.DE', kind: 'etf', symbol: 'VWCE.DE', quantity: 80, valueCents: 1100000 });
  assert.equal(seed.holdings[1].valueCents, 1880000);
  const pf = sanitizePortfolio({ ...emptyPortfolio(), ...seed });
  assert.equal(pf.holdings.length, 2, 'übersteht die Prüfung');
  assert.equal(sanitizePortfolio({ accounts: [{ id: 'a' }], holdings: [{ id: 'h', accountId: 'a', valueCents: null }] }).holdings[0].valueCents, null, 'kein Wert bleibt leer');
});

test('sanitizePortfolio: Ungültiges fällt weg, Stände nach Datum, idempotent', () => {
  const raw = {
    accounts: [{ id: 'a1', name: ' Depot ' }, { name: 'ohne id' }],
    holdings: [{ id: 'h1', accountId: 'a1', name: 'X', kind: 'quatsch', symbol: 'vwce.de', quantity: '-3', valueCents: 12.6 }, { id: 'h2', accountId: 'fremd' }],
    deposits: [{ id: 'e1', accountId: 'a1', date: '2026-1-1', amountCents: 5 }],
    snapshots: [{ date: '2026-10-02', assetsCents: 2 }, { date: '2026-10-01', assetsCents: 1 }, { date: 'x' }],
    settings: { range: '5J', loanAsDebt: false },
  };
  const pf = sanitizePortfolio(raw);
  assert.deepEqual(pf.accounts, [{ id: 'a1', name: 'Depot' }]);
  assert.deepEqual(pf.holdings, [{ id: 'h1', accountId: 'a1', name: 'X', kind: 'sonstiges', symbol: 'VWCE.DE', quantity: 0, valueCents: 13 }]);
  assert.equal(pf.deposits.length, 0);
  assert.deepEqual(pf.snapshots.map((s) => s.date), ['2026-10-01', '2026-10-02']);
  assert.deepEqual(pf.settings, { loanAsDebt: false, lastBackup: null, range: '3M' });
  assert.deepEqual(sanitizePortfolio(JSON.parse(JSON.stringify(pf))), pf);
});
