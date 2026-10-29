// Datenmodell: Stammdaten, Standardwerte, Prüfung der Eingaben und Austauschformat (JSON).
// Keine Abhängigkeiten, keine Anzeigetexte. Später in Swift: Structs und Enums mit denselben Feldern.

export const APP_ID = 'darlehen-tracker';
/** Version des Export-Formats. Bei jeder Änderung der Datenform erhöhen und `upgradeRaw` erweitern. */
export const SCHEMA_VERSION = 1;

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
export function buildExport(input, exportedAt) {
  return { app: APP_ID, version: SCHEMA_VERSION, exportiert: exportedAt, eingaben: input };
}

/**
 * Hebt ältere Rohdaten auf die aktuelle Form (idempotent). Version 1 ist die erste Form;
 * ältere Dateien ohne Hülle (nur Eingaben, oder `input` statt `eingaben`) werden eingepackt.
 */
export function upgradeRaw(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.eingaben || data.input) return { ...data, eingaben: data.eingaben || data.input };
  return { eingaben: data };
}

/**
 * Prüft eine importierte Datei.
 * @returns {{ok: true, input: object} | {ok: false, error: 'not-object'|'newer-version'|'no-fields'}}
 */
export function parseImport(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'not-object' };
  if (Number(data.version) > SCHEMA_VERSION) return { ok: false, error: 'newer-version' };
  const up = upgradeRaw(data);
  const raw = up && up.eingaben;
  if (!raw || typeof raw !== 'object' || !Object.keys(raw).some((k) => k in APP_DEFAULTS)) return { ok: false, error: 'no-fields' };
  return { ok: true, input: sanitize(raw) };
}
