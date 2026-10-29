// Speicher: eine kleine Schnittstelle über localStorage (mit try/catch, z. B. im privaten Modus).
// Die Logik kennt den Speicher nicht. Später: IndexedDB für größere Datenmengen, in Swift: Datei oder SwiftData.

export const STORE_KEY = 'darlehen-tracker:v1';
/** Eigener Schlüssel für das Vermögen, damit der Rechner-Zustand unverändert bleibt. */
export const PORTFOLIO_KEY = 'wolpertinger:vermoegen:v1';

/** Liest den gespeicherten Zustand; null, wenn nichts da oder nicht lesbar. */
export function load(key = STORE_KEY) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
/** Speichert den Zustand; false, wenn der Browser das Speichern verweigert. */
export function save(value, key = STORE_KEY) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
