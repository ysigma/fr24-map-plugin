import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

const API_KEY = process.env.FR24_API_KEY;
const PROXY_TOKEN = process.env.PROXY_TOKEN;
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8788);
const CACHE_SECONDS = Number(process.env.CACHE_SECONDS ?? 15);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const FR24 = 'https://fr24api.flightradar24.com/api';
const MAX_LIMIT = 300;

if (!API_KEY) {
  console.error('FR24_API_KEY is not set. Start the proxy with the key in its environment.');
  process.exit(1);
}
if (!PROXY_TOKEN || PROXY_TOKEN.length < 24) {
  console.error('PROXY_TOKEN must be set (24+ characters). Clients send it in the X-Proxy-Token header.');
  process.exit(1);
}

const digest = s => createHash('sha256').update(String(s)).digest();
const EXPECTED_TOKEN = digest(PROXY_TOKEN);
const tokenOk = header => header != null && timingSafeEqual(digest(header), EXPECTED_TOKEN);

// Short-lived cache plus in-flight de-duplication: FR24 bills per result, so identical
// requests from several viewers (or a quick pan back and forth) share one upstream call.
const cache = new Map();

async function fr24(path, params, ttlSeconds) {
  const url = `${FR24}${path}?${new URLSearchParams(params)}`;
  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return { ...(await hit.promise), cached: true };

  const promise = (async () => {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'Accept-Version': 'v1',
        Authorization: `Bearer ${API_KEY}`,
      },
    });
    const body = await res.json().catch(() => ({}));
    return {
      status: res.status,
      body,
      credits: {
        remaining: numberOrNull(res.headers.get('x-fr24-credits-remaining')),
        consumed: numberOrNull(res.headers.get('x-fr24-credits-consumed')),
      },
    };
  })();

  cache.set(url, { promise, expires: Date.now() + ttlSeconds * 1000 });
  if (cache.size > 500) {
    for (const [k, v] of cache) if (v.expires <= Date.now()) cache.delete(k);
  }

  const result = await promise;
  if (result.status !== 200) cache.delete(url);
  return { ...result, cached: false };
}

function rows(body) {
  return Array.isArray(body) ? body : body?.data ?? [];
}

function numberOrNull(v) {
  const n = Number(v);
  return v != null && Number.isFinite(n) ? n : null;
}

function parseBounds(raw) {
  const parts = String(raw ?? '').split(',').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) return null;
  let [north, south, west, east] = parts;
  north = Math.min(90, Math.max(-90, north));
  south = Math.min(90, Math.max(-90, south));
  west = Math.min(180, Math.max(-180, west));
  east = Math.min(180, Math.max(-180, east));
  if (north <= south) return null;
  // Round to ~1 km so tiny pans reuse the cache instead of costing credits.
  return [north, south, west, east].map(n => n.toFixed(2)).join(',');
}

function send(res, status, payload, origin) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
}

function upstreamError(res, r, origin) {
  const detail = r.body?.details ?? r.body?.message ?? 'FR24 request failed';
  send(res, r.status === 429 ? 429 : 502, { error: detail, upstreamStatus: r.status }, origin);
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return send(res, 403, { error: 'Origin not allowed' });
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin ?? '',
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': 'X-Proxy-Token',
      'Access-Control-Max-Age': '600',
    });
    return res.end();
  }
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' }, origin);

  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/healthz') return send(res, 200, { ok: true }, origin);
    if (!tokenOk(req.headers['x-proxy-token'])) {
      return send(res, 401, { error: 'Missing or wrong proxy access token' }, origin);
    }

    if (url.pathname === '/api/live') {
      const bounds = parseBounds(url.searchParams.get('bounds'));
      if (!bounds) return send(res, 400, { error: 'bounds must be north,south,west,east' }, origin);
      const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 50));
      const r = await fr24('/live/flight-positions/light', { bounds, limit }, CACHE_SECONDS);
      if (r.status !== 200) return upstreamError(res, r, origin);
      return send(res, 200, {
        flights: rows(r.body),
        limit,
        credits: r.credits,
        cached: r.cached,
        fetchedAt: new Date().toISOString(),
      }, origin);
    }

    if (url.pathname === '/api/flight') {
      const callsign = (url.searchParams.get('callsign') ?? '').toUpperCase();
      if (!/^[A-Z0-9]{2,10}$/.test(callsign)) return send(res, 400, { error: 'invalid callsign' }, origin);
      const r = await fr24('/live/flight-positions/full', { callsigns: callsign, limit: 1 }, 30);
      if (r.status !== 200) return upstreamError(res, r, origin);
      return send(res, 200, { flight: rows(r.body)[0] ?? null, credits: r.credits, cached: r.cached }, origin);
    }

    if (url.pathname === '/api/track') {
      const id = (url.searchParams.get('id') ?? '').toLowerCase();
      if (!/^[0-9a-f]{6,12}$/.test(id)) return send(res, 400, { error: 'invalid flight id' }, origin);
      const r = await fr24('/flight-tracks', { flight_id: id }, 60);
      if (r.status !== 200) return upstreamError(res, r, origin);
      const points = (rows(r.body)[0]?.tracks ?? []).map(p => [p.lon, p.lat, p.alt]);
      return send(res, 200, { points, credits: r.credits, cached: r.cached }, origin);
    }

    if (url.pathname === '/api/names') {
      const code = /^[A-Z0-9]{3,4}$/;
      const airline = (url.searchParams.get('airline') ?? '').toUpperCase();
      const airports = (url.searchParams.get('airports') ?? '')
        .toUpperCase().split(',').filter(c => code.test(c)).slice(0, 2);
      const lookups = [
        code.test(airline) ? fr24(`/static/airlines/${airline}/light`, {}, 600) : null,
        ...airports.map(c => fr24(`/static/airports/${c}/light`, {}, 600)),
      ];
      const [airlineRes, ...airportRes] = await Promise.all(lookups);
      const nameOf = r => (r && r.status === 200 ? r.body?.name ?? null : null);
      return send(res, 200, {
        airline: nameOf(airlineRes),
        airports: Object.fromEntries(airports.map((c, i) => [c, nameOf(airportRes[i])])),
      }, origin);
    }

    send(res, 404, { error: 'Not found' }, origin);
  } catch (err) {
    console.error(err);
    send(res, 500, { error: 'Proxy error' }, origin);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`FR24 proxy listening on http://${HOST}:${PORT} (cache ${CACHE_SECONDS}s, origins: ${ALLOWED_ORIGINS.join(', ')})`);
});
