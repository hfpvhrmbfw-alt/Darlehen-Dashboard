// Rechenlogik für das Vermögen: Werte, Summen, Tagesstände, Veränderung und Rendite im Zeitraum.
// Reine Funktionen ohne DOM, Speicher, Netz und Uhr. "Heute" (JJJJ-MM-TT) und "jetzt" (ms) kommen als Parameter.
// Beträge in ganzen Cent. Ergebnisse sind Daten, keine Anzeigetexte.

import { HOLDING_KINDS } from './model.js';

const DAY_MS = 86400000;

/** Tag "JJJJ-MM-TT" als ganze Tage seit 1970 (UTC, zeitzonenfest). */
export function dayNumber(day) {
  const [y, m, d] = day.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}
/** Ganze Tage seit 1970 als "JJJJ-MM-TT" (gregorianischer Kalender, Rechnung nach H. Hinnant „civil_from_days“). */
export function dayString(n) {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
/** Tag plus k Tage. */
export function addDays(day, k) { return dayString(dayNumber(day) + k); }

/** Umrechnungskurs Währung → Euro; null, wenn unbekannt. */
export function fxRate(currency, fx) {
  if (!currency || currency === 'EUR') return 1;
  return fx[currency] ? fx[currency].rate : null;
}

/**
 * Wert einer Position in Cent.
 * Mit Symbol, Anteilen und bekanntem Kurs: Anteile × Kurs (in Euro umgerechnet), Quelle 'kurs'.
 * Sonst der eingetragene Wert, Quelle 'manuell'. Fehlt beides (oder der Wechselkurs): cents null, Quelle 'fehlt'.
 * @returns {{cents: number|null, source: 'kurs'|'manuell'|'fehlt', currency: string|null}}
 */
export function holdingValue(h, prices, fx) {
  const p = h.symbol ? prices[h.symbol] : null;
  if (h.symbol && h.quantity !== null && p) {
    const rate = fxRate(p.currency, fx);
    if (rate === null) return { cents: h.valueCents, source: h.valueCents === null ? 'fehlt' : 'manuell', currency: p.currency };
    return { cents: Math.round(h.quantity * p.price * rate * 100), source: 'kurs', currency: p.currency };
  }
  if (h.valueCents !== null) return { cents: h.valueCents, source: 'manuell', currency: 'EUR' };
  return { cents: null, source: 'fehlt', currency: null };
}

function zeroKinds() {
  const o = {};
  for (const k of HOLDING_KINDS) o[k] = 0;
  return o;
}

/**
 * Summen des Vermögens.
 * linkedDebtCents: Schuld aus dem Darlehen-Rechner (0, wenn nicht als Schuld gezählt).
 * Reihenfolge der Zeilen: nach Wert absteigend, bei Gleichstand wie in `holdings`.
 */
export function totals(pf, linkedDebtCents = 0) {
  const byKind = zeroKinds();
  let assets = 0, missing = 0;
  const rows = pf.holdings.map((h, i) => {
    const v = holdingValue(h, pf.prices, pf.fx);
    if (v.cents === null) missing++;
    else { assets += v.cents; byKind[h.kind] += v.cents; }
    return { holdingId: h.id, accountId: h.accountId, kind: h.kind, cents: v.cents, source: v.source, currency: v.currency, order: i };
  });
  for (const r of rows) r.share = assets > 0 && r.cents !== null ? r.cents / assets : null;
  rows.sort((a, b) => (b.cents ?? -Infinity) - (a.cents ?? -Infinity) || a.order - b.order);
  const debt = pf.debts.reduce((s, d) => s + d.amountCents, 0) + Math.max(0, Math.round(linkedDebtCents));
  return { assetsCents: assets, debtCents: debt, netCents: assets - debt, liquidCents: byKind.cash, byKind, rows, missing };
}

/** Summe aller Einzahlungen (Auszahlungen negativ) bis einschließlich `day`. */
export function depositsUpTo(deposits, day) {
  let s = 0;
  for (const d of deposits) if (d.date <= day) s += d.amountCents;
  return s;
}

/** Tagesstand für `today`. */
export function makeSnapshot(pf, today, linkedDebtCents = 0) {
  const t = totals(pf, linkedDebtCents);
  return { date: today, assetsCents: t.assetsCents, debtCents: t.debtCents, depositsCents: depositsUpTo(pf.deposits, today), byKind: t.byKind };
}

/** Fügt einen Tagesstand ein; ein Stand vom selben Tag wird ersetzt. Liste bleibt nach Datum sortiert. */
export function upsertSnapshot(list, snap) {
  const out = list.filter((s) => s.date !== snap.date);
  out.push(snap);
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

const net = (s) => s.assetsCents - s.debtCents;

/** Erster Tag eines Zeitraums ('1M', '3M', 'YTD', '1J', 'MAX'); null bei 'MAX'. */
export function rangeStart(range, today) {
  const [y, m, d] = today.split('-').map(Number);
  const back = (months) => {
    const t = y * 12 + (m - 1) - months;
    const yy = Math.floor(t / 12), mm = (t % 12) + 1;
    const last = Math.round((Date.UTC(yy, mm, 1) - Date.UTC(yy, mm - 1, 1)) / DAY_MS);
    return `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
  };
  if (range === '1M') return back(1);
  if (range === '3M') return back(3);
  if (range === '1J') return back(12);
  if (range === 'YTD') return `${y}-01-01`;
  return null;
}

/** Tagesstände im Zeitraum als Punkte { date, netCents }. Der letzte Stand vor dem Zeitraum dient als Anfang. */
export function series(snapshots, range, today) {
  const from = rangeStart(range, today);
  if (from === null) return snapshots.map((s) => ({ date: s.date, netCents: net(s) }));
  const inside = snapshots.filter((s) => s.date >= from && s.date <= today);
  const before = snapshots.filter((s) => s.date < from);
  const pts = before.length ? [before[before.length - 1], ...inside] : inside;
  return pts.map((s) => ({ date: s.date, netCents: net(s) }));
}

/**
 * Veränderung im Zeitraum.
 * gainCents = Veränderung des Nettovermögens minus Einzahlungen im Zeitraum (also ohne Sparrate).
 * returnRate: vereinfachte Rendite nach Dietz, Gewinn / (Anfangswert + halbe Einzahlungen); null, wenn nicht sinnvoll.
 */
export function periodChange(snapshots, range, today) {
  const pts = snapshots.filter((s) => s.date <= today);
  if (!pts.length) return { from: null, to: null, startNetCents: null, endNetCents: null, diffCents: null, depositsCents: null, gainCents: null, returnRate: null };
  const end = pts[pts.length - 1];
  const fromDay = rangeStart(range, today);
  let start = pts[0];
  if (fromDay !== null) {
    const before = pts.filter((s) => s.date <= fromDay);
    start = before.length ? before[before.length - 1] : pts[0];
  }
  const diff = net(end) - net(start);
  const dep = end.depositsCents - start.depositsCents;
  const gain = diff - dep;
  const base = net(start) + dep / 2;
  return {
    from: start.date, to: end.date,
    startNetCents: net(start), endNetCents: net(end),
    diffCents: diff, depositsCents: dep, gainCents: gain,
    returnRate: start.date !== end.date && base > 0 ? gain / base : null,
  };
}

/** Aufteilung nach Art heute und vor etwa einem Monat (letzter Stand am oder vor heute − 30 Tage; null, wenn keiner). */
export function allocationCompare(snapshots, today, nowByKind) {
  const cut = addDays(today, -30);
  const before = snapshots.filter((s) => s.date <= cut);
  return { now: nowByKind, before: before.length ? before[before.length - 1].byKind : null, beforeDate: before.length ? before[before.length - 1].date : null };
}

/** Symbole, deren Kurs fehlt oder älter als maxAgeMs ist (Reihenfolge wie in `holdings`, ohne Doppelte). */
export function staleSymbols(pf, nowMs, maxAgeMs = 3600000) {
  const out = [];
  for (const h of pf.holdings) {
    if (!h.symbol || out.includes(h.symbol)) continue;
    const p = pf.prices[h.symbol];
    const at = p && p.fetchedAt ? Date.parse(p.fetchedAt) : NaN;
    if (!p || !Number.isFinite(at) || nowMs - at > maxAgeMs) out.push(h.symbol);
  }
  return out;
}

/** Fremdwährungen aus den Kursen, deren Wechselkurs fehlt oder älter als maxAgeMs ist. */
export function staleCurrencies(pf, nowMs, maxAgeMs = 3600000) {
  const out = [];
  for (const h of pf.holdings) {
    const p = h.symbol ? pf.prices[h.symbol] : null;
    if (!p || p.currency === 'EUR' || out.includes(p.currency)) continue;
    const f = pf.fx[p.currency];
    const at = f && f.fetchedAt ? Date.parse(f.fetchedAt) : NaN;
    if (!f || !Number.isFinite(at) || nowMs - at > maxAgeMs) out.push(p.currency);
  }
  return out;
}

/** Ältester Abrufzeitpunkt der Kurse aller Positionen mit Symbol (ISO) oder null. */
export function oldestQuote(pf) {
  let oldest = null;
  for (const h of pf.holdings) {
    const p = h.symbol ? pf.prices[h.symbol] : null;
    if (p && p.fetchedAt && (oldest === null || p.fetchedAt < oldest)) oldest = p.fetchedAt;
  }
  return oldest;
}

/** Ist eine Sicherung fällig? Nur wenn es Daten gibt und die letzte Sicherung fehlt oder älter als `days` Tage ist. */
export function backupDue(pf, today, days = 30) {
  if (!pf.holdings.length && !pf.debts.length) return false;
  if (!pf.settings.lastBackup) return true;
  return dayNumber(today) - dayNumber(pf.settings.lastBackup) > days;
}

/**
 * Erster Bestand aus den Eingaben des Darlehen-Rechners (eigenes ETF-Depot, Darlehens-Depot, Krypto).
 * makeId liefert neue IDs (die Oberfläche übergibt crypto.randomUUID, Tests eine feste Folge).
 */
export function seedFromCalculator(input, makeId) {
  const accounts = [], holdings = [];
  const add = (name, list) => {
    const id = makeId();
    accounts.push({ id, name });
    for (const h of list) holdings.push({ id: makeId(), accountId: id, ...h });
  };
  const sym = input.etfSymbol ? String(input.etfSymbol).toUpperCase() : null;
  const etfPos = (shares, value, label = 'Welt-ETF') => (sym && shares > 0
    ? { name: label === 'Welt-ETF' ? sym : `${sym} (Darlehen)`, kind: 'etf', symbol: sym, quantity: shares, valueCents: Math.round(value * 100) }
    : { name: label, kind: 'etf', symbol: null, quantity: null, valueCents: Math.round(value * 100) });
  if (input.etf > 0 || input.etfShares > 0) add('ETF-Depot', [etfPos(input.etfShares, input.etf)]);
  // Wie im Rechner: 0 heißt „noch nicht investiert“, dann gilt der Darlehensbetrag.
  const loanValue = input.loanEtfNow > 0 ? input.loanEtfNow : input.loan > 0 ? input.loan : 0;
  if (input.loanShares > 0 || loanValue > 0) add('Darlehens-Depot', [etfPos(input.loanShares, loanValue, 'Welt-ETF (Darlehen)')]);
  if (input.crypto > 0) add('Krypto', [{ name: 'Krypto', kind: 'krypto', symbol: null, quantity: null, valueCents: Math.round(input.crypto * 100) }]);
  return { accounts, holdings };
}
