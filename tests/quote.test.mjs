// Tests für den Kursabruf (ohne Netz, mit nachgebildeten Antworten)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChart, parseSearch, routes, viaProxy, fetchVia, chartUrl } from '../quote.js';

const chart = { chart: { result: [{ meta: { currency: 'EUR', symbol: 'VWCE.DE', longName: 'Vanguard FTSE All-World UCITS ETF', regularMarketPrice: 132.5, regularMarketTime: 1791300000, fullExchangeName: 'XETRA' } }], error: null } };

test('Chart-Antwort: Kurs, Währung, Name, Zeit', () => {
  const q = parseChart(chart);
  assert.equal(q.price, 132.5);
  assert.equal(q.currency, 'EUR');
  assert.equal(q.symbol, 'VWCE.DE');
  assert.equal(q.time, new Date(1791300000 * 1000).toISOString());
});

test('Chart-Antwort: Ersatz über Schlusskurse und Pence-Umrechnung', () => {
  const q = parseChart({ chart: { result: [{ meta: { currency: 'GBp', symbol: 'VWRL.L' }, timestamp: [1, 2], indicators: { quote: [{ close: [9000, null] }] } }] } });
  assert.equal(q.price, 90);
  assert.equal(q.currency, 'GBP');
  assert.throws(() => parseChart({ chart: { result: null, error: { code: 'Not Found', description: 'No data found' } } }), /No data found/);
});

test('Suche: nur passende Wertpapierarten', () => {
  const r = parseSearch({ quotes: [{ symbol: 'VWCE.DE', quoteType: 'ETF', longname: 'Vanguard FTSE All-World', exchDisp: 'XETRA' }, { symbol: 'X', quoteType: 'FUTURE' }] });
  assert.deepEqual(r.map((x) => x.symbol), ['VWCE.DE']);
});

test('Abrufwege: direkt, eigener Proxy, öffentlicher Proxy', () => {
  const url = chartUrl('VWCE.DE');
  assert.equal(viaProxy('https://p.example/?u={url}', url), 'https://p.example/?u=' + encodeURIComponent(url));
  assert.equal(routes(url, {}).length, 1);
  assert.equal(routes(url, { proxy: 'https://p.example/?u=', allowPublic: true }).length, 3);
});

test('Abruf fällt auf den nächsten Weg zurück, wenn Yahoo blockiert', async () => {
  const calls = [];
  globalThis.fetch = async (u) => {
    calls.push(u);
    if (u.startsWith('https://query1')) throw new TypeError('Failed to fetch');
    return { ok: true, json: async () => chart };
  };
  const r = await fetchVia(chartUrl('VWCE.DE'), parseChart, { proxy: 'https://p.example/?u={url}' });
  assert.equal(r.via, 'eigener Proxy');
  assert.equal(r.data.price, 132.5);
  assert.match(r.tried[0], /CORS/);
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(fetchVia(chartUrl('X'), parseChart, {}), /blockiert/);
});
