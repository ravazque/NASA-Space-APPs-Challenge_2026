import test from "node:test";
import assert from "node:assert/strict";
import { makeEntry, listEntries, canSetStatus, canCorrect, markerOf, activeCount, hhmm, utcLabel, PHOTO_MAX, ZONE_MAX_CELLS, POLY_MAX, thinPoly, zoneTarget, EQUIP_ID_RE } from "./log.js";
import { initialDoc, applyOp, check, decide } from "./sync-core.js";
import { overlay, entryCells } from "./effects.js";

const me = { deviceId: "A1", crew: "EV1", role: "crew" }, clock = { utcMs: 1721083230000, sol: 1210, ltst: 14.53 };
const mk = (f = {}, id = "A1:1") => makeEntry({ section: "hazard", severity: 3, cell: 100, title: "Loose block field", ...f }, { id, me, clock, wallMs: 5 });
const photo = "data:image/webp;base64,AAAA";

test("makeEntry fills the spec 5.1 schema", () => {
  const e = mk({ note: " check ", radius_m: 60, data: { kind: "rock" } });
  assert.deepEqual(e, {
    id: "A1:1", section: "hazard", severity: 3, cell: 100, radius_m: 60, profiles: ["foot", "vehicle", "cargo"], title: "Loose block field", note: "check",
    data: { kind: "rock" }, author: { deviceId: "A1", crew: "EV1" }, utcMs: 1721083230000, wallMs: 5, sol: 1210, ltst: 14.53, tag: "REPORTED", status: "open",
  });
});

test("severity applies to fault, hazard and env_change only; the rest is fixed at 1", () => {
  assert.equal(mk({ section: "fault", severity: 2 }).severity, 2);
  assert.equal(mk({ severity: 9 }).severity, 3);
  assert.equal(mk({ severity: "x" }).severity, 2);
  for (const section of ["route_deviation", "sample", "equipment", "note"]) assert.equal(mk({ section, severity: 3 }).severity, 1, section);
});

test("limits: title 60, note 500, radius 0-200, profiles default to all", () => {
  const e = mk({ title: "x".repeat(99), note: "n".repeat(900), radius_m: 999, profiles: ["vehicle", "boat"] });
  assert.equal(e.title.length, 60); assert.equal(e.note.length, 500); assert.equal(e.radius_m, 200); assert.deepEqual(e.profiles, ["vehicle"]);
  assert.equal(mk({ radius_m: -5 }).radius_m, 0);
  assert.deepEqual(mk({ profiles: [] }).profiles, ["foot", "vehicle", "cargo"]);
});

test("section data is whitelisted per section", () => {
  assert.deepEqual(mk({ section: "fault", data: { kind: "scarp", offset_m: 1.2, junk: 1 } }).data, { kind: "scarp", offset_m: 1.2 });
  assert.deepEqual(mk({ section: "fault", data: { kind: "nope", offset_m: -1 } }).data, { kind: "other" });
  assert.deepEqual(mk({ section: "env_change", data: { what: "frost" } }).data, { what: "frost" });
  assert.deepEqual(mk({ section: "route_deviation", data: { path: [1, 2, "x", 3.5], reason: "boulders" } }).data, { path: [1, 2], reason: "boulders" });
  assert.deepEqual(mk({ section: "sample", data: { sample_id: "S-12", rock: "olivine" } }).data, { sample_id: "S-12", rock: "olivine" });
  assert.deepEqual(mk({ section: "equipment", data: { item: "drill", state: "left_here" } }).data, { item: "drill", state: "left_here" });
  assert.deepEqual(mk({ section: "note", data: { x: 1 } }).data, {});
});

test("invalid input throws the name of the field", () => {
  const bad = (f, field) => assert.throws(() => mk(f), { message: field });
  bad({ section: "weather" }, "section"); bad({ cell: -1 }, "cell"); bad({ cell: 1.5 }, "cell"); bad({ cell: undefined }, "cell");
  bad({ title: "   " }, "title"); bad({ photo: "http://x/y.png" }, "photo"); bad({ photo: "data:image/webp;base64," + "A".repeat(PHOTO_MAX) }, "photo");
});

test("photo and correction ride in data", () => {
  const e = mk({ photo, supersedes: "A1:0" });
  assert.equal(e.data.photo, photo); assert.equal(e.data.supersedes, "A1:0");
});

test("log.append through the shared reducer: appended once, newest first, idempotent by id", () => {
  let doc = initialDoc(0);
  const a = mk({}, "A1:1"), b = mk({ section: "sample", title: "Core" }, "A1:2");
  doc = applyOp(doc, { t: "log.append", entry: a }, { seq: 1 });
  doc = applyOp(doc, { t: "log.append", entry: b }, { seq: 2 });
  const again = applyOp(doc, { t: "log.append", entry: a }, { seq: 3 });
  assert.equal(again.log, doc.log); assert.equal(again.logOrder.length, 2);
  assert.deepEqual(listEntries(doc).map((x) => x.e.id), ["A1:2", "A1:1"]);
  assert.deepEqual(listEntries(doc, { section: "sample" }).map((x) => x.e.id), ["A1:2"]);
  assert.equal(listEntries(doc)[0].e.status, "open");
  assert.equal(activeCount(doc), 2);
});

test("a correction marks the old entry superseded", () => {
  let doc = initialDoc(0);
  doc = applyOp(doc, { t: "log.append", entry: mk({}, "A1:1") }, { seq: 1 });
  doc = applyOp(doc, { t: "log.append", entry: mk({ supersedes: "A1:1", severity: 1 }, "A1:2") }, { seq: 2 });
  const rows = listEntries(doc);
  assert.deepEqual(rows.map((r) => [r.e.id, r.superseded]), [["A1:2", false], ["A1:1", true]]);
  assert.equal(activeCount(doc), 1);
});

test("record -> routing: a REPORTED sev-3 hazard blocks the cells, a resolved one frees them", () => {
  const rows = 21, cols = 21, C = 10 * cols + 10, G = { rows, cols, cellM: 20, nowUtcMs: clock.utcMs, me: { deviceId: "B" }, profile: "foot", locks: [] };
  let doc = applyOp(initialDoc(0), { t: "log.append", entry: mk({ cell: C, radius_m: 20 }, "A1:1"), }, { seq: 1, provisional: true });
  const entries = () => doc.logOrder.map((i) => doc.log[i]);
  assert.equal(doc.log["A1:1"].provisional, true);
  assert.equal(overlay({ ...G, entries: entries() }).mult[C], Infinity);
  doc = { ...doc, log: { ...doc.log, "A1:1": { ...doc.log["A1:1"], status: "resolved" } } };
  assert.equal(overlay({ ...G, entries: entries() }).blocked, 0);
});

test("status permissions mirror the hub: author or base resolves, others confirm", () => {
  const e = mk(), other = { deviceId: "B2", role: "crew" }, base = { deviceId: "H", role: "base" };
  assert.equal(canSetStatus(e, "confirmed", me), false);
  assert.equal(canSetStatus(e, "confirmed", other), true);
  assert.equal(canSetStatus(e, "resolved", me), true);
  assert.equal(canSetStatus(e, "resolved", other), false);
  assert.equal(canSetStatus(e, "resolved", base), true);
  assert.equal(canSetStatus({ ...e, status: "confirmed" }, "confirmed", other), false);
  assert.equal(canSetStatus({ ...e, status: "resolved" }, "resolved", base), false);
  assert.equal(canSetStatus({ ...e, provisional: true }, "resolved", me), false);
});

test("map markers: kind by section, radius circle only for active sev >= 2 hazards", () => {
  assert.equal(markerOf(mk()).kind, "hazard"); assert.equal(markerOf(mk()).radius_m, 40);
  assert.equal(markerOf(mk({ section: "fault" })).kind, "fault");
  assert.equal(markerOf(mk({ section: "env_change" })).kind, "note");
  assert.equal("radius_m" in markerOf(mk({ severity: 1 })), false);
  assert.equal("radius_m" in markerOf({ ...mk(), status: "resolved" }), false);
  assert.equal(markerOf({ ...mk(), status: "resolved" }).stale, true);
  assert.equal(markerOf({ ...mk(), provisional: true }).provisional, true);
});

test("Mars and UTC time labels", () => {
  assert.equal(hhmm(14.53), "14:31"); assert.equal(hhmm(23.999), "23:59"); assert.equal(hhmm(null), "--:--");
  assert.equal(utcLabel(1721083230000), "2024-07-15 22:40 UTC");
});

const grid = { rows: 356, cols: 193 }, from = { deviceId: "A1", crew: "EV1", role: "crew" }, B = { deviceId: "B2", crew: "EV2", role: "crew" }, base = { deviceId: "H", crew: "BASE", role: "base" };
const ask = (doc, op, f = from) => decide(doc, { op }, f, 1e6, { grid });
const withLog = (...entries) => entries.reduce((d, e) => applyOp(d, { t: "log.append", entry: e }, { seq: d.seq + 1 }), initialDoc(0));

test("contract: zone, route and equipment lock requests are accepted by the hub", () => {
  const cells = [1, 2, 3], base0 = { cells, profiles: ["foot"], reason: "x", sticky: false, ttlMs: 30000 };
  assert.equal(check({ t: "lock.request", target: zoneTarget("A1B2C3D4", Date.now()), kind: "zone", ...base0 }, grid).err, undefined);
  assert.match(zoneTarget("A1", 1.7e12 + 123), /^zone:A1:\d{1,9}$/);
  assert.equal(check({ t: "lock.request", target: "route:A1", kind: "route", ...base0 }, grid).err, undefined);
  assert.equal(check({ t: "lock.request", target: "equip:rover1", kind: "equipment", profiles: ["foot"], reason: "equipment", sticky: false, ttlMs: 30000 }, grid).err, undefined);
  assert.equal(EQUIP_ID_RE.test("rover1"), true);
  assert.equal(EQUIP_ID_RE.test("sim:rover1"), false);
});

test("contract: zone limits match the hub (cells under one 64 KB frame, 64 polygon vertices)", () => {
  const cells = Array.from({ length: ZONE_MAX_CELLS }, (_, i) => 59000 + i);
  const op = { t: "lock.request", target: zoneTarget("A1", 5), kind: "zone", cells, poly: Array.from({ length: POLY_MAX }, (_, i) => i), profiles: ["foot", "vehicle", "cargo"], reason: "r", sticky: false, ttlMs: 30000 };
  assert.ok(JSON.stringify({ type: "op", id: 99999, op }).length < 65536);
  assert.equal(check(op, grid).err, undefined);
  const long = Array.from({ length: 200 }, (_, i) => i), thin = thinPoly(long);
  assert.ok(thin.length <= POLY_MAX && thin.length > 3);
  assert.equal(thinPoly([1, 2, 3]).length, 3);
});

test("contract: a report with a photo passes the hub, an oversize or malformed photo does not", () => {
  const big = "data:image/webp;base64," + "A".repeat(PHOTO_MAX - 30);
  const e = mk({ photo: big });
  assert.equal(ask(initialDoc(0), { t: "log.append", entry: e }).nack, undefined);
  const hub = ask(initialDoc(0), { t: "log.append", entry: e }).ops[0].entry;
  assert.equal(hub.data.photo, big);
  assert.equal(check({ t: "log.append", entry: { ...e, data: { ...e.data, photo: "data:text/html;base64,AAAA" } } }, grid).err, "invalid");
  assert.equal(check({ t: "log.append", entry: { ...e, data: { ...e.data, photo: big + "A".repeat(100) } } }, grid).err, "invalid");
  assert.equal(check({ t: "log.append", entry: { ...e, data: { ...e.data, x: "y".repeat(9000) } } }, grid).err, "invalid");
});

test("correction: only the author's device or a base may supersede; the UI offers Correct on the same rule", () => {
  const orig = { ...mk({}, "A1:1"), author: { deviceId: "A1", crew: "EV1" } }, doc = withLog(orig);
  const fix = (id) => mk({ severity: 1, supersedes: "A1:1" }, id);
  assert.equal(ask(doc, { t: "log.append", entry: fix("A1:2") }).nack, undefined);
  assert.equal(ask(doc, { t: "log.append", entry: fix("B2:1") }, B).nack, "forbidden");
  assert.equal(ask(doc, { t: "log.append", entry: fix("H:1") }, base).nack, undefined);
  assert.equal(ask(initialDoc(0), { t: "log.append", entry: fix("A1:2") }).nack, "forbidden");
  assert.equal(canCorrect(orig, false, me), true);
  assert.equal(canCorrect(orig, false, { deviceId: "B2", role: "crew" }), false);
  assert.equal(canCorrect(orig, false, { deviceId: "H", role: "base" }), true);
  assert.equal(canCorrect(orig, true, me), false);
  assert.equal(canCorrect({ ...orig, status: "resolved" }, false, me), false);
});

test("a corrected entry is never named as the reroute cause (entryCells honours supersede)", () => {
  const G = { rows: 50, cols: 50, cellM: 20, nowUtcMs: clock.utcMs, me: { deviceId: "B" }, profile: "foot", locks: [] };
  const old = mk({ cell: 1225 }, "A1:1"), fix = mk({ cell: 1225, severity: 1, supersedes: "A1:1" }, "A1:2");
  overlay({ ...G, entries: [old] });
  assert.ok(entryCells(old).length > 0);
  overlay({ ...G, entries: [old, fix] });
  assert.equal(entryCells(old).length, 0);
});

test("lock.release without a fence is refused by the hub, so a provisional lock must not offer Release", () => {
  const doc = initialDoc(0);
  assert.equal(ask(doc, { t: "lock.release", target: "route:A1", fence: null }).ops?.length ?? 0, 0);
  const granted = applyOp(doc, { t: "lock.grant", lock: { target: "route:A1", kind: "route", cells: [1, 2], holder: { deviceId: "A1", crew: "EV1" }, profiles: ["foot"], reason: "", sticky: false, expiresAt: 9e9 } }, { seq: 1 });
  assert.equal(ask(granted, { t: "lock.release", target: "route:A1" }).nack, "invalid");
});

test("markerOf takes a section label function so the map plate is translated", () => {
  assert.equal(markerOf(mk({ section: "env_change" }), null, (s) => `T(${s})`).sub, "EV1 · T(env_change)");
});
