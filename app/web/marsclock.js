export const SOL_S = 88775.244;
export const JEZERO = { lat: 18.4447, lonE: 77.4508 };
export const SOL0_MSD = 52304;

const DEG_TO_RAD = Math.PI / 180;
const MS_PER_DAY = 8.64e7;
const MARS_SOL_IN_DAYS = 1.0274912517;
const TT_MINUS_UTC_DAYS = 69.184 / 86400;
const JULIAN_DATE_UNIX_EPOCH = 2440587.5;
const JULIAN_DATE_J2000 = 2451545.0;

const SEASONS = ["spring", "summer", "autumn", "winter"];

// Planetary perturbation terms [amplitude, period, phase] (Allison & McEwen 2000)
const PERTURBERS = [
  [0.0071, 2.2353, 49.409],
  [0.0057, 2.7543, 168.173],
  [0.0039, 1.1177, 191.837],
  [0.0037, 15.7866, 21.736],
  [0.0021, 2.1354, 15.704],
  [0.0020, 2.4694, 95.528],
  [0.0018, 32.8493, 49.095],
];

function mod(a, n) {
  return ((a % n) + n) % n;
}

function utcToMsd(daysSinceJ2000) {
  return (daysSinceJ2000 - 4.5) / MARS_SOL_IN_DAYS + 44796.0 - 0.0009626;
}

function msdToUtcMs(msd) {
  const days = (msd + 0.0009626 - 44796.0) * MARS_SOL_IN_DAYS + 4.5;
  const julianDate = days + JULIAN_DATE_J2000 - TT_MINUS_UTC_DAYS;
  return (julianDate - JULIAN_DATE_UNIX_EPOCH) * MS_PER_DAY;
}

export function mars(utcMs, lonE = JEZERO.lonE, lat = JEZERO.lat) {
  const dt = JULIAN_DATE_UNIX_EPOCH + utcMs / MS_PER_DAY + TT_MINUS_UTC_DAYS - JULIAN_DATE_J2000;
  const meanAnomaly = mod(19.3871 + 0.52402073 * dt, 360);
  const fictitiousMeanSun = 270.3871 + 0.524038496 * dt;

  let perturbation = 0;
  for (const [amplitude, period, phase] of PERTURBERS) {
    perturbation += amplitude * Math.cos((0.985626 * dt / period + phase) * DEG_TO_RAD);
  }

  const sinM = (k) => Math.sin(k * meanAnomaly * DEG_TO_RAD);
  const cosM = (k) => Math.cos(k * meanAnomaly * DEG_TO_RAD);
  const equationOfCenter = (10.691 + 3e-7 * dt) * sinM(1)
    + 0.623 * sinM(2)
    + 0.050 * sinM(3)
    + 0.005 * sinM(4)
    + 0.0005 * sinM(5)
    + perturbation;

  const ls = mod(fictitiousMeanSun + equationOfCenter, 360);
  const sinLs = (k) => Math.sin(k * ls * DEG_TO_RAD);
  const eot = 2.861 * sinLs(2) - 0.071 * sinLs(4) + 0.002 * sinLs(6) - equationOfCenter;

  const msd = utcToMsd(dt);
  const lmst = mod(24 * msd + lonE / 15, 24);
  const trueSolarHours = 24 * (msd + lonE / 360) + eot / 15;
  const ltst = mod(trueSolarHours, 24);
  const sol = Math.floor(trueSolarHours / 24) - SOL0_MSD;

  const declination = Math.asin(0.42565 * sinLs(1)) / DEG_TO_RAD + 0.25 * sinLs(1);
  const hourAngle = 15 * (ltst - 12) * DEG_TO_RAD;
  const latRad = lat * DEG_TO_RAD;
  const decRad = declination * DEG_TO_RAD;
  const sinSunEl = Math.sin(latRad) * Math.sin(decRad)
    + Math.cos(latRad) * Math.cos(decRad) * Math.cos(hourAngle);
  const sunEl = Math.asin(sinSunEl) / DEG_TO_RAD;
  const sunAz = mod(
    Math.atan2(
      Math.sin(hourAngle),
      Math.cos(hourAngle) * Math.sin(latRad) - Math.tan(decRad) * Math.cos(latRad),
    ) / DEG_TO_RAD + 180,
    360,
  );

  const rAU = 1.523679 * (1.00436
    - 0.09309 * cosM(1)
    - 0.004336 * cosM(2)
    - 0.00031 * cosM(3)
    - 0.00003 * cosM(4));

  return {
    msd,
    mtc: mod(24 * msd, 24),
    lmst,
    ltst,
    ls,
    eot,
    dec: declination,
    sunEl,
    sunAz,
    rAU,
    sol,
    season: seasonOf(ls),
    dustSeason: ls >= 180 && ls < 330,
  };
}

export function solToUtc(sol, ltstH = 0) {
  let eot = 0;
  let utc = 0;
  for (let i = 0; i < 4; i++) {
    const msd = SOL0_MSD + sol + (ltstH - eot / 15) / 24 - JEZERO.lonE / 360;
    utc = msdToUtcMs(msd);
    eot = mars(utc).eot;
  }
  return Math.round(utc);
}

export function clockUtc(clock, hubNowMs) {
  let utc = clock.anchorUtcMs;
  if (!clock.paused) {
    utc += (hubNowMs - clock.anchorWallMs) * clock.rate;
  }
  if (clock.mode === "replay" && clock.replaySol != null) {
    const solStart = solToUtc(clock.replaySol, 0);
    const solLength = solToUtc(clock.replaySol + 1, 0) - solStart;
    utc = solStart + mod(utc - solStart, solLength);
  }
  return utc;
}

export function seasonOf(ls) {
  return SEASONS[Math.floor(mod(ls, 360) / 90)];
}

export function fmtHM(hours) {
  const minutes = Math.round(mod(hours, 24) * 60) % 1440;
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function utcAtLs(targetLs, fromUtcMs) {
  const lsError = (utc) => mod(mars(utc).ls - targetLs + 180, 360) - 180;
  const DAY_MS = 864e5;
  let lo = fromUtcMs;
  let errLo = lsError(lo);
  for (let day = 0; day < 700; day++) {
    const hi = lo + DAY_MS;
    const errHi = lsError(hi);
    if (errLo < 0 && errHi >= 0) {
      return bisectCrossing(lsError, lo, hi);
    }
    lo = hi;
    errLo = errHi;
  }
  return fromUtcMs;
}

function bisectCrossing(error, lo, hi) {
  while (hi - lo > 1000) {
    const mid = (lo + hi) / 2;
    if (error(mid) < 0) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return Math.round(hi);
}
