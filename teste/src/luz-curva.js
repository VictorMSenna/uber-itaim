// F23: one continuous light curve for the whole site (outside 3D, interior, photo night grade).
// Everything follows the SUN ELEVATION through the twilight bands, never a day/night boolean:
//   <= -12 deg  deep night (astronomical/nautical)      -6..0 deg  blue hour (civil twilight)
//   0..~10 deg  golden hour (warm, weak, long shadows)  > ~20 deg  full day
// Below the horizon B3's sol.json has no samples, so the elevation there comes from the NOAA solar position
// equations (same source B3 used), for the same date, latitude/longitude and UTC-3.

const rad = Math.PI / 180;
export const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// NOAA simplified solar position. dataISO 'YYYY-MM-DD', minutos local (UTC-3), returns { el, az } in degrees.
export function posicaoSolar(dataISO, minutos, lat = -23.59415, lon = -46.67462, fusoH = -3) {
  const [Y, M, D] = dataISO.split('-').map(Number);
  const inicioAno = Date.UTC(Y, 0, 1);
  const doy = Math.floor((Date.UTC(Y, M - 1, D) - inicioAno) / 86400000) + 1;
  const g = (2 * Math.PI / 365) * (doy - 1 + (minutos / 60 - 12) / 24);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const tst = minutos + eqt + 4 * lon - 60 * fusoH;
  const ha = (tst / 4 - 180) * rad;
  const phi = lat * rad;
  const cosz = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  const zen = Math.acos(Math.max(-1, Math.min(1, cosz)));
  let az = Math.acos(Math.max(-1, Math.min(1, (Math.sin(phi) * Math.cos(zen) - Math.sin(decl)) / (Math.cos(phi) * Math.sin(zen))))) / rad;
  az = ha > 0 ? (az + 180) % 360 : (540 - az) % 360;
  return { el: 90 - zen / rad, az };
}

// 0 = deep night .. 1 = full day, continuous in the elevation
export function fatorDia(el) { return smooth(-14, 22, el); }
// night lights (status windows, interior lamps): fade in from civil twilight to nautical
export function fatorLuzesNoite(el) { return 1 - smooth(-13, 6, el); }
// direct sun: 0 at the horizon, airmass fall-off near it, full above ~25 deg
export function forcaSolDireto(el) {
  if (el <= 0) return 0;
  const s = Math.sin(el * rad);
  return Math.min(1, (1 - Math.exp(-el / 3.5)) * Math.pow(s, 0.35) * 1.05);
}
// warm low sun: 0 = white (high), 1 = deep orange (at horizon)
export function calorSol(el) { return 1 - smooth(1, 22, el); }

const mistura = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
// sky gradient colours (top, horizon) by elevation, through night -> blue hour -> golden hour -> day
const CEU = [
  [-18, [10, 15, 30], [21, 32, 56]],
  [-12, [13, 20, 38], [29, 41, 69]],
  [-9, [20, 30, 56], [46, 60, 96]],
  [-6, [32, 46, 84], [78, 88, 126]],
  [-3, [50, 68, 112], [150, 128, 132]],
  [0, [70, 92, 138], [214, 158, 124]],
  [3, [110, 140, 180], [240, 190, 140]],
  [10, [150, 175, 200], [230, 215, 190]],
  [22, [195, 203, 201], [226, 221, 211]],
];
export function corCeu(el) {
  if (el <= CEU[0][0]) return { topo: hex(CEU[0][1]), horizonte: hex(CEU[0][2]) };
  for (let i = 1; i < CEU.length; i++) {
    if (el <= CEU[i][0]) {
      const k = (el - CEU[i - 1][0]) / (CEU[i][0] - CEU[i - 1][0]); // linear between keys: no steep middle
      return { topo: hex(mistura(CEU[i - 1][1], CEU[i][1], k)), horizonte: hex(mistura(CEU[i - 1][2], CEU[i][2], k)) };
    }
  }
  const u = CEU[CEU.length - 1];
  return { topo: hex(u[1]), horizonte: hex(u[2]) };
}

// sky luminance as a fraction of full day: log-shaped, like the real twilight sky (about 10x darker for every
// ~12 deg of elevation lost). Use it for light that comes FROM the sky (window light in the interior); the
// exposure follows fatorDia, so the eye adapts while the sky itself fades exponentially.
// Above the horizon a gentle smoothstep (golden hour), below it ~10x darker every 8 deg; continuous at 0 deg.
export function fatorCeu(el) { return el >= 0 ? 0.2 + 0.8 * smooth(0, 22, el) : 0.2 * Math.pow(10, el / 8); }
