import { PLANE_SVG_PATH } from './aircraft.js';

const num = n => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');

function Stat({ label, value }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>{value ?? '—'}</dd>
    </div>
  );
}

function Airport({ iata, icao, name, align }) {
  return (
    <div className={`airport ${align}`}>
      <div className="airport-code">{iata || icao || '—'}</div>
      <div className="airport-name">{name || (iata ? icao : 'Unknown')}</div>
    </div>
  );
}

function ago(timestamp, now) {
  const t = Date.parse(timestamp);
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ${s % 60}s ago`;
}

export default function FlightPanel({ flight, details, names, now, onClose }) {
  const d = details ?? {};
  const live = flight ?? d;
  const callsign = live.callsign || d.callsign || '';
  const orig = d.orig_iata || d.orig_icao;
  const dest = d.dest_iata || d.dest_icao;
  const airline = names?.airline || d.operating_as || d.painted_as;
  const eta = Date.parse(d.eta);
  const loading = details == null;

  return (
    <aside className="panel" aria-label="Flight details">
      <header className="panel-head">
        <div className="panel-title">
          <div className="panel-flight">{d.flight || callsign || live.fr24_id}</div>
          <div className="panel-sub">
            {[callsign, airline].filter(Boolean).join(' · ') || (loading ? 'Loading…' : 'No flight details')}
          </div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close flight details">
          ×
        </button>
      </header>

      <section className="route">
        <Airport iata={d.orig_iata} icao={d.orig_icao} name={names?.airports?.[orig]} align="left" />
        <svg className="route-plane" viewBox="0 0 64 64" aria-hidden="true">
          <path d={PLANE_SVG_PATH} transform="rotate(90 32 32)" />
        </svg>
        <Airport iata={d.dest_iata} icao={d.dest_icao} name={names?.airports?.[dest]} align="right" />
      </section>

      {Number.isFinite(eta) && (
        <div className="eta">
          Estimated arrival{' '}
          <strong>
            {new Date(eta).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC
          </strong>
        </div>
      )}

      <dl className="stats">
        <Stat label="Aircraft" value={d.type} />
        <Stat label="Registration" value={d.reg} />
        <Stat label="Altitude" value={Number.isFinite(live.alt) ? `${num(live.alt)} ft` : null} />
        <Stat label="Ground speed" value={Number.isFinite(live.gspeed) ? `${num(live.gspeed)} kt` : null} />
        <Stat label="Vertical speed" value={Number.isFinite(live.vspeed) ? `${num(live.vspeed)} fpm` : null} />
        <Stat label="Track" value={Number.isFinite(live.track) ? `${Math.round(live.track)}°` : null} />
        <Stat label="Squawk" value={live.squawk} />
        <Stat label="Mode-S" value={live.hex} />
        <Stat label="Source" value={live.source} />
        <Stat label="Last update" value={ago(live.timestamp, now)} />
      </dl>

      {!flight && <p className="panel-note">This aircraft is outside the current map view, so its position isn't updating.</p>}

      <footer className="panel-foot">Flight data © Flightradar24</footer>
    </aside>
  );
}
