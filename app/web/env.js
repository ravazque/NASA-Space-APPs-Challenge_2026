const todo = (n) => { throw new Error(`env.${n}: not implemented (clock lane)`); };
export const loadEnv = async () => todo("loadEnv");
export const resolveEnv = (envData, m, clock, override, utcMs) => todo("resolveEnv");
export const density = (p, T) => todo("density");
export const uv = (rAU, szaDeg, tau) => todo("uv");
export const tauClim = (ls) => todo("tauClim");
export const hazardLevel = ({ tau, dtau_h, wind_ms }) => todo("hazardLevel");
export const groundTempGrid = (tiSi, tRoverC, tMeanC, tiRover) => todo("groundTempGrid");
