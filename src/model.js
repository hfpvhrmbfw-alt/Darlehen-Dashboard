// Datenmodell: Stammdaten, Standardwerte, Prüfung der Eingaben und Austauschformat (JSON).
// Keine Abhängigkeiten, keine Anzeigetexte. Später in Swift: Structs und Enums mit denselben Feldern.

export const APP_ID = 'darlehen-tracker';
/** Version des Export-Formats. Bei jeder Änderung der Datenform erhöhen und `upgradeRaw` erweitern. */
export const SCHEMA_VERSION = 2; // 2: Vermögen (`vermoegen`) im Export

export const VARIANTS = Object.freeze(['A', 'B']);                        // A = Raten aus dem Einkommen, B = Verkauf aus dem ETF
export const PLAN_MODES = Object.freeze(['standard', 'simple', 'custom']); // Rückzahlungsplan
export const TERMS = Object.freeze([5, 10, 20]);                          // Tilgungsdauer in Jahren

/** Eingaben des Darlehen-Rechners (Prozentwerte als Zahl, z. B. 6 für 6 %). */
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
  variant: 'A',         // siehe VARIANTS
  ageNow: 30,           // Alter heute
  ageTarget: 60,        // Zielalter (Horizont = Zielalter − Alter heute)
  taxRate: 26.375,      // Steuer auf ETF-Gewinn in %
  exemption: 30,        // Teilfreistellung in %
  inflation: 2,         // Inflation pro Jahr in %
  loanEtfNow: 0,        // Darlehensgeld im ETF heute in € (0 = noch nicht investiert, dann gilt der Darlehensbetrag)
  planMode: 'standard', // siehe PLAN_MODES
  planAmount: 500,      // einfacher Plan: Auszahlung pro Monat in €
  planStart: '',        // einfacher Plan: erster Zahlmonat "JJJJ-MM" (leer = nach der tilgungsfreien Zeit)
  planCustom: [],       // individueller Plan: [{ m: "JJJJ-MM", a: Betrag }]
});

/** Eingaben der App: Rechner plus Kursabruf (Symbol und Anteile). */
export const APP_DEFAULTS = Object.freeze({ ...DEFAULTS, etfSymbol: '', etfShares: 0, loanShares: 0 });

const TEXT_KEYS = ['variant', 'planMode', 'planStart', 'planCustom', 'etfSymbol'];
export const NUM_KEYS = Object.freeze(Object.keys(APP_DEFAULTS).filter((k) => !TEXT_KEYS.includes(k)));
const MONTH_RE = /^\d{4}-\d{2}$/;

/** Bringt beliebige Rohdaten in eine gültige Eingabe; Unbekanntes oder Ungültiges fällt auf den Standardwert zurück. */
export function sanitize(raw) {
  const out = { ...APP_DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of NUM_KEYS) {
    if (k in raw) {
      const v = typeof raw[k] === 'string' ? Number(raw[k].replace(',', '.')) : Number(raw[k]);
      if (Number.isFinite(v)) out[k] = v;
    }
  }
  if (VARIANTS.includes(raw.variant)) out.variant = raw.variant;
  if (PLAN_MODES.includes(raw.planMode)) out.planMode = raw.planMode;
  if (typeof raw.planStart === 'string' && (raw.planStart === '' || MONTH_RE.test(raw.planStart))) out.planStart = raw.planStart;
  if (Array.isArray(raw.planCustom)) {
    out.planCustom = raw.planCustom
      .filter((r) => r && MONTH_RE.test(String(r.m)) && Number.isFinite(Number(r.a)))
      .slice(0, 1200)
      .map((r) => ({ m: String(r.m), a: Math.max(0, Number(r.a)) }));
  }
  if (typeof raw.etfSymbol === 'string') out.etfSymbol = raw.etfSymbol.slice(0, 60);
  return out;
}

/** Export-Objekt. `exportedAt` (ISO-Zeitstempel) kommt von außen, damit das Modell keine Uhr liest. */
export function buildExport(input, portfolio, exportedAt) {
  return { app: APP_ID, version: SCHEMA_VERSION, exportiert: exportedAt, eingaben: input, vermoegen: portfolio };
}

/**
 * Hebt ältere Rohdaten auf die aktuelle Form (idempotent). Version 1 ist die erste Form;
 * ältere Dateien ohne Hülle (nur Eingaben, oder `input` statt `eingaben`) werden eingepackt.
 * Version 1 kennt kein Vermögen; `vermoegen` fehlt dann und bleibt beim Import unverändert.
 */
export function upgradeRaw(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.eingaben || data.input) return { ...data, eingaben: data.eingaben || data.input };
  return { eingaben: data };
}

/**
 * Prüft eine importierte Datei.
 * @returns {{ok: true, input: object, portfolio: object|null} | {ok: false, error: 'not-object'|'newer-version'|'no-fields'}}
 *   portfolio ist null, wenn die Datei kein Vermögen enthält (Version 1).
 */
export function parseImport(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'not-object' };
  if (Number(data.version) > SCHEMA_VERSION) return { ok: false, error: 'newer-version' };
  const up = upgradeRaw(data);
  const raw = up && up.eingaben;
  if (!raw || typeof raw !== 'object' || !Object.keys(raw).some((k) => k in APP_DEFAULTS)) return { ok: false, error: 'no-fields' };
  const portfolio = up.vermoegen && typeof up.vermoegen === 'object' ? sanitizePortfolio(up.vermoegen) : null;
  return { ok: true, input: sanitize(raw), portfolio };
}

// ---------- Vermögen ----------
// Beträge als ganze Cent (Int), Datum als "JJJJ-MM-TT", IDs als Strings (UUID). Später in Swift: Structs mit denselben Feldern.

export const PORTFOLIO_SCHEMA_VERSION = 1;
export const HOLDING_KINDS = Object.freeze(['etf', 'aktie', 'krypto', 'anleihe', 'cash', 'sonstiges']);
export const RANGES = Object.freeze(['1M', '3M', 'YTD', '1J', 'MAX']);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Leerer Vermögensbestand. */
export function emptyPortfolio() {
  return { accounts: [], holdings: [], debts: [], deposits: [], prices: {}, fx: {}, snapshots: [], settings: { loanAsDebt: true, lastBackup: null, range: '3M' } };
}

const str = (v, max = 80) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const cents = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const idOk = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64;

/** Bringt einen gespeicherten oder importierten Vermögensbestand in gültige Form; Ungültiges fällt weg. */
export function sanitizePortfolio(raw) {
  const out = emptyPortfolio();
  if (!raw || typeof raw !== 'object') return out;
  const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
  out.accounts = list(raw.accounts).filter((a) => idOk(a.id)).map((a) => ({ id: a.id, name: str(a.name) || 'Konto' }));
  const accIds = new Set(out.accounts.map((a) => a.id));
  out.holdings = list(raw.holdings).filter((h) => idOk(h.id) && accIds.has(h.accountId)).map((h) => {
    const quantity = numOrNull(h.quantity);
    return {
      id: h.id, accountId: h.accountId, name: str(h.name) || 'Position',
      kind: HOLDING_KINDS.includes(h.kind) ? h.kind : 'sonstiges',
      symbol: str(h.symbol, 40).toUpperCase() || null,
      quantity: quantity === null ? null : Math.max(0, quantity),
      valueCents: cents(h.valueCents),
    };
  });
  out.debts = list(raw.debts).filter((d) => idOk(d.id)).map((d) => ({ id: d.id, name: str(d.name) || 'Schuld', amountCents: Math.max(0, cents(d.amountCents) || 0) }));
  out.deposits = list(raw.deposits).filter((d) => idOk(d.id) && accIds.has(d.accountId) && DAY_RE.test(String(d.date)) && cents(d.amountCents) !== null)
    .map((d) => ({ id: d.id, accountId: d.accountId, date: d.date, amountCents: cents(d.amountCents) }));
  if (raw.prices && typeof raw.prices === 'object') {
    for (const [sym, p] of Object.entries(raw.prices)) {
      if (p && Number.isFinite(Number(p.price)) && Number(p.price) > 0) out.prices[str(sym, 40).toUpperCase()] = { price: Number(p.price), currency: str(p.currency, 8) || 'EUR', time: typeof p.time === 'string' ? p.time : null, fetchedAt: typeof p.fetchedAt === 'string' ? p.fetchedAt : null, via: str(p.via) || null, name: str(p.name, 120) || null };
    }
  }
  if (raw.fx && typeof raw.fx === 'object') {
    for (const [cur, f] of Object.entries(raw.fx)) {
      if (f && Number.isFinite(Number(f.rate)) && Number(f.rate) > 0) out.fx[str(cur, 8)] = { rate: Number(f.rate), fetchedAt: typeof f.fetchedAt === 'string' ? f.fetchedAt : null };
    }
  }
  const byDate = new Map();
  for (const s of list(raw.snapshots)) {
    if (!DAY_RE.test(String(s.date))) continue;
    const byKind = {};
    for (const k of HOLDING_KINDS) byKind[k] = cents(s.byKind && s.byKind[k]) || 0;
    byDate.set(s.date, { date: s.date, assetsCents: cents(s.assetsCents) || 0, debtCents: cents(s.debtCents) || 0, depositsCents: cents(s.depositsCents) || 0, byKind });
  }
  out.snapshots = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const st = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  out.settings = {
    loanAsDebt: st.loanAsDebt !== false,
    lastBackup: DAY_RE.test(String(st.lastBackup)) ? st.lastBackup : null,
    range: RANGES.includes(st.range) ? st.range : '3M',
  };
  return out;
}
