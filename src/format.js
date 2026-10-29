// Zahlenformat für die Anzeige (deutsch, Minus als „−“). Gehört zur Oberfläche, ist aber rein und testbar.

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
