const EARTH_RADIUS_M = 6371008.8;
const KNOTS_TO_MPS = 1852 / 3600;
const MAX_EXTRAPOLATION_S = 180;

const rad = d => (d * Math.PI) / 180;
const deg = r => (r * 180) / Math.PI;

export function destination(lon, lat, bearingDeg, distanceM) {
  const angular = distanceM / EARTH_RADIUS_M;
  const bearing = rad(bearingDeg);
  const lat1 = rad(lat);
  const lon1 = rad(lon);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );
  return [((deg(lon2) + 540) % 360) - 180, deg(lat2)];
}

// Moves each aircraft along its reported track at its ground speed between API refreshes,
// so the map animates without spending credits. Capped so stale positions don't drift far.
export function projectedPosition(flight, now) {
  if (!Number.isFinite(flight.t0) || !(flight.gspeed > 30)) return [flight.lon, flight.lat];
  const seconds = Math.min(MAX_EXTRAPOLATION_S, Math.max(0, (now - flight.t0) / 1000));
  return destination(flight.lon, flight.lat, flight.track, flight.gspeed * KNOTS_TO_MPS * seconds);
}

const ALTITUDE_STOPS = [
  [0, [255, 140, 0]],
  [2000, [255, 208, 0]],
  [6000, [166, 226, 46]],
  [12000, [39, 208, 127]],
  [20000, [25, 198, 214]],
  [30000, [59, 124, 255]],
  [38000, [141, 77, 255]],
  [45000, [196, 60, 255]],
];

export function altitudeColor(ft) {
  const alt = Math.max(0, ft ?? 0);
  for (let i = 1; i < ALTITUDE_STOPS.length; i++) {
    const [a0, c0] = ALTITUDE_STOPS[i - 1];
    const [a1, c1] = ALTITUDE_STOPS[i];
    if (alt <= a1) {
      const t = (alt - a0) / (a1 - a0);
      return `rgb(${c0.map((v, k) => Math.round(v + (c1[k] - v) * t)).join(',')})`;
    }
  }
  return `rgb(${ALTITUDE_STOPS.at(-1)[1].join(',')})`;
}

export const ALTITUDE_LEGEND = ALTITUDE_STOPS.map(([ft]) => ({ ft, color: altitudeColor(ft) }));

// Groups consecutive track points into one line per 1,000 ft band so a 2,000-point
// long-haul track renders as a few dozen coloured segments instead of thousands.
export function trailFeatures(points) {
  const stride = Math.max(1, Math.ceil(points.length / 800));
  const pts = points.filter((_, i) => i % stride === 0 || i === points.length - 1);
  const features = [];
  let current = null;
  for (const [lon, lat, alt] of pts) {
    const band = Math.round((alt ?? 0) / 1000);
    if (!current || current.band !== band) {
      if (current) {
        current.coords.push([lon, lat]);
        features.push(lineFeature(current.coords, current.band * 1000));
      }
      current = { band, coords: [[lon, lat]] };
    } else {
      current.coords.push([lon, lat]);
    }
  }
  if (current && current.coords.length > 1) features.push(lineFeature(current.coords, current.band * 1000));
  return features;
}

export function lineFeature(coords, alt) {
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: coords },
    properties: { color: altitudeColor(alt) },
  };
}
