import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AttributionControl, Map as MapLibreMap, NavigationControl, setWorkerUrl } from 'maplibre-gl';
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { useConfig, useEditorPanelConfig } from '@sigmacomputing/plugin';
import { addAircraftImages, PLANE_SVG_PATH } from './aircraft.js';
import { ALTITUDE_LEGEND, lineFeature, projectedPosition, trailFeatures } from './geo.js';
import FlightPanel from './FlightPanel.jsx';

const MAP_STYLES = {
  Dark: 'https://tiles.openfreemap.org/styles/dark',
  Light: 'https://tiles.openfreemap.org/styles/positron',
};
const REFRESH_SECONDS = {
  Manual: 0,
  '30 seconds': 30,
  '60 seconds': 60,
  '2 minutes': 120,
  '5 minutes': 300,
};
const EDITOR_PANEL = [
  {
    name: 'proxyUrl',
    type: 'text',
    label: 'FR24 proxy URL',
    defaultValue: 'http://localhost:8788',
    placeholder: 'https://your-proxy.example.com',
  },
  { name: 'proxyToken', type: 'text', label: 'Proxy access token', secure: true, placeholder: 'Paste the proxy token' },
  {
    name: 'maxAircraft',
    type: 'dropdown',
    label: 'Max aircraft per refresh (about 6 credits each)',
    values: ['10', '20', '50', '100', '200', '300'],
    defaultValue: '20',
  },
  { name: 'refresh', type: 'dropdown', label: 'Auto refresh', values: Object.keys(REFRESH_SECONDS), defaultValue: '2 minutes' },
  { name: 'mapStyle', type: 'dropdown', label: 'Map style', values: Object.keys(MAP_STYLES), defaultValue: 'Dark' },
  { name: 'showLabels', type: 'toggle', label: 'Show callsign labels', defaultValue: true },
  { name: 'startView', type: 'text', label: 'Start view (lat, lon, zoom)', defaultValue: '51.47, -0.45, 7' },
];
const EMPTY = { type: 'FeatureCollection', features: [] };
// FR24 returned at most 20 live positions per request on the plan this was built against,
// whatever limit was sent, so hitting 20 also means aircraft are being left out.
const FR24_PER_REQUEST_CAP = 20;

setWorkerUrl(mapWorkerUrl);
const iconSize = scale => ['interpolate', ['linear'], ['zoom'], 2, 0.3 * scale, 6, 0.42 * scale, 10, 0.55 * scale, 14, 0.7 * scale];

function settingsFrom(config) {
  const c = config ?? {};
  const pick = name => c[name] ?? EDITOR_PANEL.find(o => o.name === name).defaultValue;
  const startView = String(pick('startView') ?? '');
  return {
    proxyUrl: (String(pick('proxyUrl') ?? '').trim() || 'http://localhost:8788').replace(/\/+$/, ''),
    proxyToken: String(c.proxyToken ?? '').trim(),
    maxAircraft: Number(pick('maxAircraft')) || 20,
    refreshSeconds: REFRESH_SECONDS[pick('refresh')] ?? 120,
    mapStyle: MAP_STYLES[pick('mapStyle')] ? pick('mapStyle') : 'Dark',
    showLabels: pick('showLabels') !== false,
    startView,
  };
}

function parseView(text) {
  const [lat, lon, zoom] = text.split(',').map(s => Number(s.trim()));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { center: [-0.45, 51.47], zoom: 7 };
  return { center: [lon, lat], zoom: Number.isFinite(zoom) ? zoom : 7 };
}

const selectedFilter = id => ['==', ['get', 'id'], id ?? ''];
const unselectedFilter = id => ['!=', ['get', 'id'], id ?? ''];

function addOverlay(map, { showLabels, selectedId }) {
  addAircraftImages(map);
  if (!map.getSource('planes')) map.addSource('planes', { type: 'geojson', data: EMPTY });
  if (!map.getSource('trail')) map.addSource('trail', { type: 'geojson', data: EMPTY });
  const planeLayout = {
    'icon-size': iconSize(1),
    'icon-rotate': ['get', 'track'],
    'icon-rotation-alignment': 'map',
    'icon-allow-overlap': true,
    'icon-ignore-placement': true,
  };
  const addLayer = layer => map.getLayer(layer.id) || map.addLayer(layer);
  addLayer({
    id: 'trail',
    type: 'line',
    source: 'trail',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 2, 10, 4] },
  });
  addLayer({
    id: 'planes',
    type: 'symbol',
    source: 'planes',
    filter: unselectedFilter(selectedId),
    layout: { ...planeLayout, 'icon-image': 'plane' },
  });
  addLayer({
    id: 'plane-labels',
    type: 'symbol',
    source: 'planes',
    minzoom: 7,
    layout: {
      visibility: showLabels ? 'visible' : 'none',
      'text-field': ['get', 'callsign'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 11,
      'text-offset': [0, 1.5],
      'text-anchor': 'top',
      'text-optional': true,
    },
    paint: { 'text-color': '#f2f2f2', 'text-halo-color': 'rgba(0,0,0,0.85)', 'text-halo-width': 1.2 },
  });
  addLayer({
    id: 'plane-selected',
    type: 'symbol',
    source: 'planes',
    filter: selectedFilter(selectedId),
    layout: { ...planeLayout, 'icon-image': 'plane-selected', 'icon-size': iconSize(1.2) },
  });
}

function proxyFetch({ proxyUrl, proxyToken }, path, signal) {
  return fetch(`${proxyUrl}${path}`, { signal, headers: { 'X-Proxy-Token': proxyToken } });
}

function relative(ms, now) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 5 ? 'just now' : s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

export default function App() {
  useEditorPanelConfig(EDITOR_PANEL);
  const config = useConfig();
  const settings = useMemo(() => settingsFrom(config), [config]);

  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const loadedRef = useRef(false);
  const settingsRef = useRef(settings);
  const flightsRef = useRef([]);
  const selectedRef = useRef(null);
  const trailRef = useRef([]);
  const abortRef = useRef(null);
  const lastCostRef = useRef(null);

  const [flights, setFlights] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [details, setDetails] = useState(null);
  const [names, setNames] = useState(null);
  const [status, setStatus] = useState({ loading: false, error: null, updatedAt: null });
  const [query, setQuery] = useState('');
  const [now, setNow] = useState(Date.now());

  settingsRef.current = settings;
  selectedRef.current = selectedId;

  const pushPlanes = useCallback(() => {
    const map = mapRef.current;
    const planes = map?.getSource('planes');
    if (!planes) return;
    const t = Date.now();
    planes.setData({
      type: 'FeatureCollection',
      features: flightsRef.current.map(f => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: projectedPosition(f, t) },
        properties: { id: f.fr24_id, callsign: f.callsign || '', track: f.track ?? 0 },
      })),
    });
    const trail = map.getSource('trail');
    if (!trail) return;
    const base = trailRef.current;
    const selected = flightsRef.current.find(f => f.fr24_id === selectedRef.current);
    const tail = selected && base.length
      ? [lineFeature([base.at(-1).geometry.coordinates.at(-1), projectedPosition(selected, t)], selected.alt)]
      : [];
    trail.setData({ type: 'FeatureCollection', features: [...base, ...tail] });
  }, []);

  const fetchLive = useCallback(async () => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    const { proxyUrl, proxyToken, maxAircraft } = settingsRef.current;
    if (!proxyToken) {
      setStatus(s => ({ ...s, loading: false, error: 'Add the proxy access token in the editor panel.' }));
      return;
    }
    const b = map.getBounds();
    const bounds = [b.getNorth(), b.getSouth(), b.getWest(), b.getEast()].map(n => n.toFixed(3)).join(',');
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStatus(s => ({ ...s, loading: true }));
    try {
      const res = await proxyFetch(settingsRef.current, `/api/live?bounds=${bounds}&limit=${maxAircraft}`, ctrl.signal);
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) throw new Error('The proxy rejected the access token. Check it in the editor panel.');
      if (!res.ok) throw new Error(body.error || `Proxy returned HTTP ${res.status}`);
      const list = (body.flights ?? []).map(f => ({ ...f, t0: Date.parse(f.timestamp) }));
      flightsRef.current = list;
      setFlights(list);
      if (!body.cached && Number.isFinite(body.credits?.consumed)) lastCostRef.current = body.credits.consumed;
      setStatus({
        loading: false,
        error: null,
        updatedAt: Date.now(),
        limitReached: list.length >= Math.min(body.limit, FR24_PER_REQUEST_CAP),
        creditsLeft: body.credits?.remaining ?? null,
        lastCost: lastCostRef.current,
      });
      pushPlanes();
    } catch (err) {
      if (err.name === 'AbortError') return;
      const message = err instanceof TypeError ? `Can't reach the FR24 proxy at ${proxyUrl}. Is it running?` : err.message;
      setStatus(s => ({ ...s, loading: false, error: message }));
    }
  }, [pushPlanes]);

  useEffect(() => {
    const initial = settingsRef.current;
    const map = new MapLibreMap({
      container: containerRef.current,
      style: MAP_STYLES[initial.mapStyle],
      ...parseView(initial.startView),
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
    });
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    map.addControl(
      new AttributionControl({ compact: true, customAttribution: 'Flight data © Flightradar24' }),
      'bottom-right',
    );
    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');

    map.on('style.load', () => {
      addOverlay(map, { showLabels: settingsRef.current.showLabels, selectedId: selectedRef.current });
      pushPlanes();
    });
    map.once('load', () => {
      loadedRef.current = true;
      fetchLive();
    });

    let moveTimer;
    map.on('moveend', () => {
      clearTimeout(moveTimer);
      moveTimer = setTimeout(fetchLive, 800);
    });

    const pickAt = point =>
      map.queryRenderedFeatures(
        [[point.x - 10, point.y - 10], [point.x + 10, point.y + 10]],
        { layers: ['plane-selected', 'planes'].filter(id => map.getLayer(id)) },
      )[0];
    map.on('click', e => setSelectedId(pickAt(e.point)?.properties.id ?? null));
    map.on('mousemove', e => {
      map.getCanvas().style.cursor = pickAt(e.point) ? 'pointer' : '';
    });

    return () => {
      clearTimeout(moveTimer);
      abortRef.current?.abort();
      map.remove();
      mapRef.current = null;
      loadedRef.current = false;
    };
  }, [fetchLive, pushPlanes]);

  const styleKey = settings.mapStyle;
  const firstStyle = useRef(true);
  useEffect(() => {
    if (firstStyle.current) {
      firstStyle.current = false;
      return;
    }
    mapRef.current?.setStyle(MAP_STYLES[styleKey]);
  }, [styleKey]);

  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    mapRef.current?.jumpTo(parseView(settings.startView));
  }, [settings.startView]);

  useEffect(() => {
    const map = mapRef.current;
    if (map?.getLayer('plane-labels')) {
      map.setLayoutProperty('plane-labels', 'visibility', settings.showLabels ? 'visible' : 'none');
    }
  }, [settings.showLabels]);

  useEffect(() => {
    fetchLive();
  }, [settings.proxyUrl, settings.proxyToken, settings.maxAircraft, fetchLive]);

  useEffect(() => {
    if (!settings.refreshSeconds) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') fetchLive();
    }, settings.refreshSeconds * 1000);
    return () => clearInterval(id);
  }, [settings.refreshSeconds, fetchLive]);

  useEffect(() => {
    const id = setInterval(() => {
      pushPlanes();
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [pushPlanes]);

  useEffect(() => {
    const map = mapRef.current;
    if (map?.getLayer('planes')) {
      map.setFilter('planes', unselectedFilter(selectedId));
      map.setFilter('plane-selected', selectedFilter(selectedId));
    }
    setDetails(null);
    setNames(null);
    trailRef.current = [];
    pushPlanes();
    if (!selectedId) return;

    const ctrl = new AbortController();
    const get = path =>
      proxyFetch(settingsRef.current, path, ctrl.signal).then(r => (r.ok ? r.json() : Promise.reject(r)));

    get(`/api/track?id=${encodeURIComponent(selectedId)}`)
      .then(j => {
        trailRef.current = trailFeatures(j.points ?? []);
        pushPlanes();
      })
      .catch(() => {});

    const callsign = flightsRef.current.find(f => f.fr24_id === selectedId)?.callsign;
    if (!callsign) {
      setDetails({});
    } else {
      get(`/api/flight?callsign=${encodeURIComponent(callsign)}`)
        .then(j => {
          const d = j.flight ?? {};
          setDetails(d);
          const airline = d.operating_as || d.painted_as || '';
          const airports = [d.orig_iata || d.orig_icao, d.dest_iata || d.dest_icao].filter(Boolean).join(',');
          if (!airline && !airports) return;
          return get(`/api/names?airline=${encodeURIComponent(airline)}&airports=${encodeURIComponent(airports)}`)
            .then(setNames);
        })
        .catch(err => {
          if (err?.name !== 'AbortError') setDetails(d => d ?? {});
        });
    }
    return () => ctrl.abort();
  }, [selectedId, settings.proxyUrl, settings.proxyToken, pushPlanes]);

  useEffect(() => {
    const onKey = e => e.key === 'Escape' && setSelectedId(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (q.length < 2) return [];
    return flights.filter(f => (f.callsign || '').toUpperCase().includes(q)).slice(0, 8);
  }, [query, flights]);

  const focusFlight = f => {
    setSelectedId(f.fr24_id);
    setQuery('');
    const map = mapRef.current;
    map?.easeTo({ center: projectedPosition(f, Date.now()), zoom: Math.max(map.getZoom(), 7) });
  };

  const selectedFlight = flights.find(f => f.fr24_id === selectedId);
  const perHour =
    settings.refreshSeconds && Number.isFinite(status.lastCost)
      ? Math.round((status.lastCost * 3600) / settings.refreshSeconds)
      : null;

  return (
    <div className="app">
      <div ref={containerRef} className="map" />

      <div className="topbar">
        <div className="brand">
          <svg viewBox="0 0 64 64" aria-hidden="true">
            <path d={PLANE_SVG_PATH} transform="rotate(45 32 32)" />
          </svg>
          <span>Live flights</span>
        </div>

        <div className="search">
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && matches[0] && focusFlight(matches[0])}
            placeholder="Search callsign in view"
            aria-label="Search callsign in view"
          />
          {matches.length > 0 && (
            <ul className="search-results">
              {matches.map(f => (
                <li key={f.fr24_id}>
                  <button onClick={() => focusFlight(f)}>
                    <strong>{f.callsign}</strong>
                    <span>{Number.isFinite(f.alt) ? `${f.alt.toLocaleString('en-US')} ft` : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="chips">
          <span className="chip">
            {flights.length.toLocaleString('en-US')} aircraft
            {status.limitReached && (
              <em title="FR24 returned the most it sends per request, so some aircraft aren't shown. Zoom in to see the rest.">
                {' '}· more not shown
              </em>
            )}
          </span>
          <span className="chip">{status.loading ? 'Updating…' : status.updatedAt ? `Updated ${relative(status.updatedAt, now)}` : 'Waiting for data'}</span>
          {Number.isFinite(status.creditsLeft) && (
            <span className="chip" title={perHour ? `About ${perHour.toLocaleString('en-US')} credits per hour from auto refresh` : undefined}>
              {status.creditsLeft.toLocaleString('en-US')} credits left
            </span>
          )}
          <button className="chip chip-btn" onClick={fetchLive} disabled={status.loading}>
            Refresh
          </button>
        </div>
      </div>

      {status.error && <div className="banner">{status.error}</div>}

      {selectedId && (
        <FlightPanel
          flight={selectedFlight}
          details={details}
          names={names}
          now={now}
          onClose={() => setSelectedId(null)}
        />
      )}

      {selectedId && (
        <div className="legend" aria-label="Altitude legend">
          {ALTITUDE_LEGEND.map(({ ft, color }) => (
            <span key={ft} style={{ background: color }}>
              {ft === 0 ? '0' : `${ft / 1000}k`}
            </span>
          ))}
          <small>ft</small>
        </div>
      )}
    </div>
  );
}
