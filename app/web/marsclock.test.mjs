import test from "node:test";
import assert from "node:assert/strict";
import { mars, solToUtc, clockUtc, seasonOf, fmtHM, utcAtLs, SOL_S } from "./marsclock.js";

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);

test("GISS worked example 2000-01-06T00:00Z", () => {
  const m = mars(Date.UTC(2000, 0, 6));
  near(m.msd, 44795.9998, 1e-4, "MSD"); near(m.ls, 277.1876, 0.01, "Ls"); near(m.eot, -5.1878, 0.01, "EOT"); near(m.mtc, 23.9956, 0.002, "MTC");
});
test("landing is sol 0; 2024-07-15T12:00Z is sol 1210 (Ls 293.69, EOT -9.05)", () => {
  assert.equal(mars(Date.UTC(2021, 1, 18, 20, 55)).sol, 0);
  const m = mars(Date.UTC(2024, 6, 15, 12));
  assert.equal(m.sol, 1210); near(m.ls, 293.69, 0.05, "Ls"); near(m.eot, -9.05, 0.05, "EOT");
  assert.equal(m.season, "winter"); assert.equal(m.dustSeason, true);
});
test("MEDA ANCILLARY sol 1210 LTST 15:28: SZA 65.59 deg -> sun elevation 24.41", () => {
  const m = mars(solToUtc(1210, 15 + 28 / 60));
  near(m.sunEl, 24.4, 0.3, "elevation"); near(m.sunAz, 233, 2, "azimuth");
  const noon = mars(solToUtc(1210, 12));
  near(noon.sunAz, 180, 0.5, "noon azimuth"); assert.ok(mars(solToUtc(1210, 9)).sunAz < 180 && mars(solToUtc(1210, 15)).sunAz > 180, "east of south in the morning, west in the afternoon");
});
test("solToUtc(1210, 11) matches the default clock anchor", () => near(solToUtc(1210, 11), 1721083230000, 60000, "anchor"));
test("today (2026-11-14) is sol 2039, Ls 21.8", () => {
  const m = mars(Date.UTC(2026, 10, 14, 12));
  assert.equal(m.sol, 2039); near(m.ls, 21.8, 0.1, "Ls");
});
test("round trip mars(solToUtc(s, h)) for 4 sols x 3 hours", () => {
  for (const s of [0, 500, 1210, 1859]) for (const h of [0.5, 12, 23.5]) {
    const m = mars(solToUtc(s, h));
    assert.equal(m.sol, s, `sol ${s}@${h}`);
    near(m.ltst, h, 1 / 60, `ltst ${s}@${h}`);
  }
});
test("clockUtc: rate, pause, replay loop", () => {
  const c = { mode: "scenario", anchorUtcMs: 1e12, anchorWallMs: 5000, rate: 600, paused: false };
  assert.equal(clockUtc(c, 6000), 1e12 + 600 * 1000);
  assert.equal(clockUtc({ ...c, paused: true }, 99999), 1e12);
  const r = { mode: "replay", replaySol: 1210, anchorUtcMs: solToUtc(1210, 11), anchorWallMs: 0, rate: 60, paused: false };
  const base = solToUtc(1210, 0);
  for (const wall of [0, 1e6, 3e6, 9e7]) {
    const u = clockUtc(r, wall);
    assert.ok(u >= base && u < base + SOL_S * 1000, `wall ${wall}`);
    assert.equal(mars(u).sol, 1210);
  }
});
test("replay loop edge is a sol edge: the last ms of the loop is still the replayed sol (0-18 s mismatch before)", () => {
  for (const sol of [658, 785, 1030, 1271]) {
    const r = { mode: "replay", replaySol: sol, anchorUtcMs: solToUtc(sol, 0), anchorWallMs: 0, rate: 1, paused: false };
    const len = solToUtc(sol + 1, 0) - solToUtc(sol, 0);
    assert.equal(mars(clockUtc(r, len - 1)).sol, sol, `end of sol ${sol}`);
    assert.ok(mars(clockUtc(r, len + 5)).ltst < 0.01, "wrapped to the start");
  }
});
test("seasonOf and fmtHM", () => {
  assert.deepEqual([0, 90, 180, 270, 359.9, 360].map(seasonOf), ["spring", "summer", "autumn", "winter", "winter", "spring"]);
  assert.equal(fmtHM(14.5), "14:30"); assert.equal(fmtHM(23.999), "00:00"); assert.equal(fmtHM(-0.5), "23:30");
});
test("utcAtLs finds the next season angle", () => {
  for (const target of [0, 90, 180, 250, 270, 359.5]) {
    const from = Date.UTC(2026, 10, 14), u = utcAtLs(target, from);
    assert.ok(u >= from && u - from < 687 * 864e5 * 1.03, `${target}`);
    near(((mars(u).ls - target + 540) % 360) - 180, 0, 0.01, `Ls ${target}`);
  }
});
