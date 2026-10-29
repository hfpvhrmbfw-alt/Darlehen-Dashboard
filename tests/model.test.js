// Datenmodell: Prüfung der Eingaben und Import/Export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_DEFAULTS, SCHEMA_VERSION, sanitize, buildExport, parseImport, upgradeRaw, emptyPortfolio } from '../src/model.js';

test('sanitize: Ungültiges fällt auf Standardwerte zurück, Kommazahlen werden gelesen', () => {
  assert.deepEqual(sanitize(null), APP_DEFAULTS);
  const s = sanitize({ loan: '25000,5', variant: 'C', planMode: 'simple', planStart: '2030-1', planCustom: [{ m: '2030-01', a: -5 }, { m: 'x', a: 1 }], etfSymbol: 'VWCE.DE' });
  assert.equal(s.loan, 25000.5);
  assert.equal(s.variant, 'A');
  assert.equal(s.planMode, 'simple');
  assert.equal(s.planStart, '');
  assert.deepEqual(s.planCustom, [{ m: '2030-01', a: 0 }]);
  assert.equal(s.etfSymbol, 'VWCE.DE');
});

test('Export und Import ergeben wieder dieselben Eingaben', () => {
  const input = sanitize({ loan: 50000, variant: 'B' });
  const pf = emptyPortfolio();
  const data = buildExport(input, pf, '2026-10-29T12:00:00.000Z');
  assert.deepEqual(data, { app: 'darlehen-tracker', version: SCHEMA_VERSION, exportiert: '2026-10-29T12:00:00.000Z', eingaben: input, vermoegen: pf });
  assert.deepEqual(parseImport(JSON.parse(JSON.stringify(data))), { ok: true, input, portfolio: pf });
  assert.equal(parseImport({ version: 1, eingaben: { loan: 1 } }).portfolio, null, 'Version 1 ohne Vermögen');
});

test('Import: ältere Formen werden angenommen, neuere und kaputte abgelehnt', () => {
  assert.equal(parseImport({ loan: 30000 }).input.loan, 30000, 'nur Eingaben, ohne Hülle');
  assert.equal(parseImport({ input: { loan: 30000 } }).input.loan, 30000, 'input statt eingaben');
  assert.deepEqual(parseImport({ version: SCHEMA_VERSION + 1, eingaben: { loan: 1 } }), { ok: false, error: 'newer-version' });
  assert.deepEqual(parseImport(5), { ok: false, error: 'not-object' });
  assert.deepEqual(parseImport([]), { ok: false, error: 'not-object' });
  assert.deepEqual(parseImport({ foo: 1 }), { ok: false, error: 'no-fields' });
});

test('upgradeRaw ist idempotent', () => {
  const once = upgradeRaw({ loan: 1 });
  assert.deepEqual(upgradeRaw(once), once);
});

test('Modell und Rechenlogik greifen nicht auf DOM, Speicher, Netz oder Uhr zu', () => {
  for (const f of ['model.js', 'loan.js', 'portfolio.js']) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
    for (const word of ['document', 'window', 'localStorage', 'indexedDB', 'fetch(', 'Date.now', 'new Date']) {
      assert.ok(!src.includes(word), `${f} enthält ${word}`);
    }
  }
});
