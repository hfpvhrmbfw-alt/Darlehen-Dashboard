// Kursabruf bei Yahoo Finance. Die einzige Fremdanfrage der App, nur auf Knopfdruck.
// Yahoo erlaubt den Abruf aus fremden Webseiten (CORS) meist nicht. Deshalb gibt es eine Kette:
// 1. direkt bei Yahoo, 2. eigener Proxy (z. B. Cloudflare Worker, siehe proxy/), 3. öffentlicher Proxy (falls erlaubt).

export const PUBLIC_PROXY = 'https://api.allorigins.win/raw?url={url}';
export const PUBLIC_PROXY_NAME = 'allorigins.win';

export function chartUrl(symbol) {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol.trim())}?range=5d&interval=1d`;
}
export function searchUrl(query) {
  return `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query.trim())}&quotesCount=8&newsCount=0&listsCount=0`;
}

/** Wendet eine Proxy-Vorlage an: {url} wird durch die kodierte Ziel-Adresse ersetzt, sonst angehängt. */
export function viaProxy(template, url) {
  const t = String(template || '').trim();
  if (!t) return null;
  return t.includes('{url}') ? t.replace('{url}', encodeURIComponent(url)) : t + encodeURIComponent(url);
}

/** Liste der Abrufwege in der Reihenfolge, in der sie versucht werden. */
export function routes(url, settings = {}) {
  const list = [{ via: 'Yahoo direkt', url }];
  const own = viaProxy(settings.proxy, url);
  if (own) list.push({ via: 'eigener Proxy', url: own });
  if (settings.allowPublic) list.push({ via: `öffentlicher Proxy (${PUBLIC_PROXY_NAME})`, url: viaProxy(PUBLIC_PROXY, url) });
  return list;
}

/** Liest Kurs, Währung, Zeit und Namen aus der Antwort des Yahoo-Chart-Endpunkts. */
export function parseChart(json) {
  const err = json && json.chart && json.chart.error;
  if (err) throw new Error(err.description || err.code || 'Yahoo meldet einen Fehler');
  const r = json && json.chart && json.chart.result && json.chart.result[0];
  if (!r || !r.meta) throw new Error('Antwort enthält keinen Kurs');
  const meta = r.meta;
  let price = Number(meta.regularMarketPrice);
  let time = Number(meta.regularMarketTime);
  if (!Number.isFinite(price)) {
    // Ersatz: letzter Schlusskurs aus der Zeitreihe
    const closes = r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close || [];
    for (let j = closes.length - 1; j >= 0; j--) if (Number.isFinite(closes[j])) { price = closes[j]; time = r.timestamp && r.timestamp[j]; break; }
  }
  if (!Number.isFinite(price) || price <= 0) throw new Error('Antwort enthält keinen gültigen Kurs');
  let currency = meta.currency || '';
  // Kurse in Pence (GBp) auf Pfund umrechnen
  if (currency === 'GBp' || currency === 'GBX') { price /= 100; currency = 'GBP'; }
  return {
    symbol: meta.symbol || '',
    name: meta.longName || meta.shortName || meta.symbol || '',
    exchange: meta.fullExchangeName || meta.exchangeName || '',
    price,
    currency,
    time: Number.isFinite(time) ? new Date(time * 1000).toISOString() : null,
  };
}

/** Liest Treffer aus der Yahoo-Suche (nur ETFs, Fonds und Aktien). */
export function parseSearch(json) {
  const quotes = (json && json.quotes) || [];
  return quotes
    .filter((q) => q && q.symbol && ['ETF', 'MUTUALFUND', 'EQUITY', 'INDEX'].includes(q.quoteType))
    .map((q) => ({ symbol: q.symbol, name: q.longname || q.shortname || q.symbol, exchange: q.exchDisp || q.exchange || '', type: q.quoteType }));
}

async function getJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Versucht alle Abrufwege nacheinander. Gibt { data, via, tried } zurück oder wirft mit allen Fehlern. */
export async function fetchVia(url, parse, settings = {}, timeoutMs = 9000) {
  const tried = [];
  for (const r of routes(url, settings)) {
    try {
      const data = parse(await getJson(r.url, timeoutMs));
      return { data, via: r.via, tried };
    } catch (err) {
      const why = err.name === 'AbortError' ? 'keine Antwort'
        : err instanceof TypeError ? 'vom Browser blockiert (CORS) oder offline'
          : (err.message || 'Fehler');
      tried.push(`${r.via}: ${why}`);
    }
  }
  const e = new Error(tried.join('; '));
  e.tried = tried;
  throw e;
}

export function fetchQuote(symbol, settings) { return fetchVia(chartUrl(symbol), parseChart, settings); }
export function searchSymbols(query, settings) { return fetchVia(searchUrl(query), parseSearch, settings); }
