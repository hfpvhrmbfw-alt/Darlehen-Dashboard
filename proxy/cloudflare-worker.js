// Kleiner Proxy für den Kursabruf bei Yahoo Finance (Cloudflare Worker, kostenloser Tarif reicht).
// Er reicht nur Anfragen an die beiden Yahoo-Endpunkte der App weiter und erlaubt nur die eigene Seite.
// Einrichtung: siehe README, Abschnitt „Eigener Proxy für den Kursabruf“.

const ALLOWED_ORIGINS = [
  'https://hfpvhrmbfw-alt.github.io',
  'http://localhost:8000',
];
const ALLOWED_TARGETS = [
  'https://query1.finance.yahoo.com/v8/finance/chart/',
  'https://query2.finance.yahoo.com/v1/finance/search',
];

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return new Response('Nur GET', { status: 405, headers: cors });
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return new Response('Herkunft nicht erlaubt', { status: 403, headers: cors });

    const target = new URL(request.url).searchParams.get('url') || '';
    if (!ALLOWED_TARGETS.some((t) => target.startsWith(t))) return new Response('Ziel nicht erlaubt', { status: 400, headers: cors });

    const upstream = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  },
};
