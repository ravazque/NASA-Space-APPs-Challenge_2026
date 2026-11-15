export const SOL_S = 88775.244;
export const JEZERO = { lat: 18.4447, lonE: 77.4508 };
export const SOL0_MSD = 52304;
const todo = (n) => { throw new Error(`marsclock.${n}: not implemented (clock lane)`); };
export const mars = (utcMs, lonE = JEZERO.lonE, lat = JEZERO.lat) => todo("mars");
export const solToUtc = (sol, ltstH = 0) => todo("solToUtc");
export const clockUtc = (clock, hubNowMs) => todo("clockUtc");
export const seasonOf = (ls) => todo("seasonOf");
export const fmtHM = (h) => todo("fmtHM");
