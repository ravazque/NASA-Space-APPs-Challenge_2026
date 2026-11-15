export const SOL_S = 88775.244;
export const JEZERO = { lat: 18.4447, lonE: 77.4508 };
export const SOL0_MSD = 52304;

const D2R = Math.PI / 180, mod = (a, n) => ((a % n) + n) % n;
const PBS = [[0.0071, 2.2353, 49.409], [0.0057, 2.7543, 168.173], [0.0039, 1.1177, 191.837], [0.0037, 15.7866, 21.736],
  [0.0021, 2.1354, 15.704], [0.0020, 2.4694, 95.528], [0.0018, 32.8493, 49.095]];

export function mars(utcMs, lonE = JEZERO.lonE, lat = JEZERO.lat) {
  const dt = 2440587.5 + utcMs / 8.64e7 + 69.184 / 86400 - 2451545.0;
  const M = mod(19.3871 + 0.52402073 * dt, 360), aFMS = 270.3871 + 0.524038496 * dt;
  const pbs = PBS.reduce((s, [A, tau, phi]) => s + A * Math.cos((0.985626 * dt / tau + phi) * D2R), 0);
  const sn = (k) => Math.sin(k * M * D2R);
  const nuM = (10.691 + 3e-7 * dt) * sn(1) + 0.623 * sn(2) + 0.050 * sn(3) + 0.005 * sn(4) + 0.0005 * sn(5) + pbs;
  const ls = mod(aFMS + nuM, 360), L = (k) => Math.sin(k * ls * D2R);
  const eot = 2.861 * L(2) - 0.071 * L(4) + 0.002 * L(6) - nuM;
  const msd = (dt - 4.5) / 1.0274912517 + 44796.0 - 0.0009626;
  const lmst = mod(24 * msd + lonE / 15, 24), tot = 24 * (msd + lonE / 360) + eot / 15;
  const ltst = mod(tot, 24), sol = Math.floor(tot / 24) - SOL0_MSD;
  const dec = Math.asin(0.42565 * L(1)) / D2R + 0.25 * L(1);
  const H = 15 * (ltst - 12) * D2R, ph = lat * D2R, dl = dec * D2R;
  const sunEl = Math.asin(Math.sin(ph) * Math.sin(dl) + Math.cos(ph) * Math.cos(dl) * Math.cos(H)) / D2R;
  const sunAz = mod(Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(ph) - Math.tan(dl) * Math.cos(ph)) / D2R + 180, 360);
  const c = (k) => Math.cos(k * M * D2R);
  const rAU = 1.523679 * (1.00436 - 0.09309 * c(1) - 0.004336 * c(2) - 0.00031 * c(3) - 0.00003 * c(4));
  return { msd, mtc: mod(24 * msd, 24), lmst, ltst, ls, eot, dec, sunEl, sunAz, rAU, sol, season: seasonOf(ls), dustSeason: ls >= 180 && ls < 330 };
}

export function solToUtc(sol, ltstH = 0) {
  const utcOfMsd = (msd) => ((msd + 0.0009626 - 44796.0) * 1.0274912517 + 4.5 + 2451545.0 - 69.184 / 86400 - 2440587.5) * 8.64e7;
  let eot = 0, utc = 0;
  for (let i = 0; i < 4; i++) {
    utc = utcOfMsd(SOL0_MSD + sol + (ltstH - eot / 15) / 24 - JEZERO.lonE / 360);
    eot = mars(utc).eot;
  }
  return Math.round(utc);
}

export function clockUtc(clock, hubNowMs) {
  let u = clock.paused ? clock.anchorUtcMs : clock.anchorUtcMs + (hubNowMs - clock.anchorWallMs) * clock.rate;
  if (clock.mode === "replay" && clock.replaySol != null) {
    const base = solToUtc(clock.replaySol, 0), len = solToUtc(clock.replaySol + 1, 0) - base;
    u = base + mod(u - base, len);
  }
  return u;
}

export const seasonOf = (ls) => ["spring", "summer", "autumn", "winter"][Math.floor(mod(ls, 360) / 90)];
export function fmtHM(h) {
  const m = Math.round(mod(h, 24) * 60) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function utcAtLs(targetLs, fromUtcMs) {
  const d = (u) => mod(mars(u).ls - targetLs + 180, 360) - 180;
  let lo = fromUtcMs, dlo = d(lo);
  for (let i = 0; i < 700; i++) {
    const hi = lo + 864e5, dhi = d(hi);
    if (dlo < 0 && dhi >= 0) { let a = lo, b = hi; while (b - a > 1000) { const mid = (a + b) / 2; if (d(mid) < 0) a = mid; else b = mid; } return Math.round(b); }
    lo = hi; dlo = dhi;
  }
  return fromUtcMs;
}
