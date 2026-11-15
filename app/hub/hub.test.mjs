import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { startHub } from "./server.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ariadne-hub-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(hub, deviceId, o = {}) { Object.assign(this, { hub, deviceId, crew: o.crew ?? deviceId.toUpperCase().slice(0, 4), role: o.role ?? "crew", n: 0, inbox: [], waiters: [] }); }
  async open() {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.hub.port}/sync`);
    this.ws.on("message", (d) => { const m = JSON.parse(d); this.inbox.push(m); this.waiters = this.waiters.filter((w) => !w(m)); });
    await new Promise((ok, no) => { this.ws.once("open", ok); this.ws.once("error", no); });
    return this;
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  hello(lastSeq = 0) { this.send({ t: "hello", v: 1, deviceId: this.deviceId, crew: this.crew, role: this.role, kind: "astronaut", lastSeq }); return this.waitFor((m) => m.t === "snapshot"); }
  op(op) { const cid = `${this.deviceId}:${++this.n}`; this.send({ t: "op", cid, op }); return cid; }
  waitFor(pred, ms = 2000) {
    const hit = this.inbox.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((ok, no) => {
      const to = setTimeout(() => no(new Error("timeout waiting for a frame")), ms);
      this.waiters.push((m) => { if (pred(m)) { clearTimeout(to); ok(m); return true; } return false; });
    });
  }
  close() { this.ws.close(); return new Promise((r) => this.ws.once("close", r)); }
}
const connect = async (hub, id, o) => { const c = await new Client(hub, id, o).open(); const snap = await c.hello(); return [c, snap]; };
const entry = (id, over = {}) => ({ id, section: "hazard", severity: 2, cell: 1000, radius_m: 40, title: "Loose sand", note: "", data: { kind: "loose_sand" }, utcMs: 1721083230000, ...over });
const zone = (id, n, cells, over = {}) => ({ t: "lock.request", target: `zone:${id}:${n}`, kind: "zone", cells, profiles: ["foot", "vehicle", "cargo"], reason: "Rockfall", sticky: false, ...over });
const get = (hub, p) => new Promise((ok, no) => http.get({ host: "127.0.0.1", port: hub.port, path: p }, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => ok({ status: r.statusCode, headers: r.headers, body: b })); }).on("error", no));

async function withHub(fn, o = {}) {
  const hub = await startHub({ port: 0, host: "127.0.0.1", dataDir: tmp(), minTtlMs: 100, tickMs: 50, ...o });
  try { await fn(hub); } finally { await hub.close(); }
}

test("1. hello -> snapshot with the doc, the seeded base asset and my own presence", () => withHub(async (hub) => {
  const [a, snap] = await connect(hub, "a1");
  assert.equal(snap.seq, hub.doc.seq);
  assert.equal(snap.doc.assets.base.kind, "base");
  assert.equal(snap.presence.a1.online, true);
  assert.equal(typeof snap.hubNow, "number");
  await a.close();
}));

test("2. an op from A reaches B with the same seq, and A gets an ack", () => withHub(async (hub) => {
  const [a] = await connect(hub, "a1"), [b] = await connect(hub, "b1");
  const cid = a.op({ t: "log.append", entry: entry("a1:1") });
  const ack = await a.waitFor((m) => m.t === "ack" && m.cid === cid), got = await b.waitFor((m) => m.t === "op" && m.op.entry?.id === "a1:1");
  assert.equal(got.seq, ack.seq);
  assert.equal(got.cid, cid);
  assert.equal(got.op.entry.author.deviceId, "a1");
  assert.equal(got.op.entry.tag, "REPORTED");
  assert.equal(hub.doc.log["a1:1"].status, "open");
  await a.close(); await b.close();
}));

test("3. a duplicate cid gets the same ack and no new seq", () => withHub(async (hub) => {
  const [a] = await connect(hub, "a1");
  const cid = a.op({ t: "log.append", entry: entry("a1:1") });
  const ack = await a.waitFor((m) => m.t === "ack" && m.cid === cid), seq = hub.doc.seq;
  a.send({ t: "op", cid, op: { t: "log.append", entry: entry("a1:1") } });
  await sleep(100);
  assert.equal(a.inbox.filter((m) => m.t === "ack" && m.cid === cid).length, 2);
  assert.equal(a.inbox.filter((m) => m.t === "ack").at(-1).seq, ack.seq);
  assert.equal(hub.doc.seq, seq);
  await a.close();
}));

test("4. an overlapping zone lock from B gets nack overlap; a disjoint one is granted", () => withHub(async (hub) => {
  const [a] = await connect(hub, "a1"), [b] = await connect(hub, "b1");
  const c1 = a.op(zone("a1", 1, [10, 11, 12], { sticky: true }));
  await a.waitFor((m) => m.t === "ack" && m.cid === c1);
  const c2 = b.op(zone("b1", 1, [12, 13]));
  const nack = await b.waitFor((m) => m.t === "nack" && m.cid === c2);
  assert.equal(nack.reason, "overlap"); assert.equal(nack.holder.deviceId, "a1");
  const c3 = b.op(zone("b1", 2, [20, 21]));
  assert.equal((await b.waitFor((m) => m.t === "ack" && m.cid === c3)).seq, hub.doc.locks["zone:b1:2"].fence);
  await a.close(); await b.close();
}));

test("5. without renewals the lease expires and lock.expired is broadcast", () => withHub(async (hub) => {
  const [a] = await connect(hub, "a1"), [b] = await connect(hub, "b1");
  const cid = a.op(zone("a1", 1, [10], { ttlMs: 300 }));
  await a.waitFor((m) => m.t === "ack" && m.cid === cid);
  assert.ok(hub.doc.locks["zone:a1:1"]);
  const exp = await b.waitFor((m) => m.t === "op" && m.op.t === "lock.expired");
  assert.equal(exp.op.target, "zone:a1:1");
  assert.equal(hub.doc.locks["zone:a1:1"], undefined);
  await a.close(); await b.close();
}));

test("6. a holder that renews keeps its lock; a sticky one never expires", () => withHub(async (hub) => {
  const [a] = await connect(hub, "a1");
  const c1 = a.op(zone("a1", 1, [10], { ttlMs: 300 })), c2 = a.op(zone("a1", 2, [30], { sticky: true, ttlMs: 300 }));
  await a.waitFor((m) => m.t === "ack" && m.cid === c2);
  for (let i = 0; i < 8; i++) { a.send({ t: "renew", target: "zone:a1:1" }); await sleep(100); }
  assert.ok(hub.doc.locks["zone:a1:1"], "renewed lock is alive");
  await sleep(500);
  assert.equal(hub.doc.locks["zone:a1:1"], undefined, "stops renewing -> expires");
  assert.ok(hub.doc.locks["zone:a1:2"], "sticky survives");
  await a.close();
}));

test("7. reconnect: B misses 3 entries and its new snapshot holds them", () => withHub(async (hub) => {
  const [a] = await connect(hub, "a1"), [b, s0] = await connect(hub, "b1");
  await b.close();
  for (let i = 1; i <= 3; i++) a.op({ t: "log.append", entry: entry(`a1:${i}`, { title: `E${i}` }) });
  await a.waitFor((m) => m.t === "ack" && m.cid === "a1:3");
  const b2 = await new Client(hub, "b1").open(), snap = await b2.hello(s0.seq);
  assert.deepEqual(snap.doc.logOrder, ["a1:1", "a1:2", "a1:3"]);
  assert.equal(snap.seq, s0.seq + 3);
  await a.close(); await b2.close();
}));

test("8. restart replays the JSONL into an equal doc", async () => {
  const dir = tmp();
  const h1 = await startHub({ port: 0, host: "127.0.0.1", dataDir: dir, minTtlMs: 100, tickMs: 50 });
  const [a] = await connect(h1, "a1");
  a.op({ t: "log.append", entry: entry("a1:1") }); a.op({ t: "set", path: "settings.goal", v: 5000 }); a.op(zone("a1", 1, [10, 11], { sticky: true }));
  await a.waitFor((m) => m.t === "ack" && m.cid === "a1:3");
  const before = h1.doc;
  await a.close(); await h1.close();
  const h2 = await startHub({ port: 0, host: "127.0.0.1", dataDir: dir, minTtlMs: 100, tickMs: 50 });
  try {
    assert.equal(h2.doc.seq, before.seq);
    assert.deepEqual(h2.doc.log, before.log);
    assert.deepEqual(h2.doc.settings, before.settings);
    assert.deepEqual(h2.doc.locks, before.locks);
    assert.deepEqual(h2.doc.assets, before.assets);
    const [b, snap] = await connect(h2, "a1");
    b.n = 0; b.op({ t: "log.append", entry: entry("a1:1") });
    assert.equal((await b.waitFor((m) => m.t === "ack")).seq, 2);
    assert.equal(h2.doc.seq, before.seq);
    await b.close();
  } finally { await h2.close(); }
});

test("9. presence goes online:false on close and keeps the last cell", () => withHub(async (hub) => {
  const [a] = await connect(hub, "a1"), [b] = await connect(hub, "b1");
  a.send({ t: "presence", cell: 4242, kind: "astronaut" });
  const p = await b.waitFor((m) => m.t === "presence" && m.deviceId === "a1" && m.cell === 4242);
  assert.equal(p.online, true);
  a.send({ t: "presence", cell: 999999999, kind: "astronaut" });
  await a.close();
  const off = await b.waitFor((m) => m.t === "presence" && m.deviceId === "a1" && m.online === false);
  assert.equal(off.cell, 4242);
  await b.close();
}));

test("10. /health is JSON with CORS, /join and /qr work, path traversal is 403, the app is served", () => withHub(async (hub) => {
  const h = await get(hub, "/health"), j = JSON.parse(h.body);
  assert.equal(j.ariadne, true); assert.equal(j.version, 2); assert.equal(h.headers["access-control-allow-origin"], "*");
  assert.equal((await get(hub, "/../Makefile")).status, 403);
  assert.equal((await get(hub, "/%2e%2e/%2e%2e/Makefile")).status, 403);
  assert.equal((await get(hub, "/..%2f..%2fMakefile")).status, 403);
  const idx = await get(hub, "/"); assert.equal(idx.status, 200); assert.match(idx.body, /ARIADNE/); assert.equal(idx.headers["cache-control"], "no-cache");
  assert.equal((await get(hub, "/nope.js")).status, 404);
  assert.match((await get(hub, "/join")).body, /<svg/);
  assert.match((await get(hub, "/qr")).headers["content-type"], /svg/);
  assert.equal((await get(hub, "/log.jsonl")).status, 200);
}));

test("11. invalid ops, oversize frames and forged identities get a nack", () => withHub(async (hub) => {
  const [a] = await connect(hub, "a1"), seq = hub.doc.seq;
  const bad = [
    { t: "set", path: "settings.nope", v: 1 }, { t: "set", path: "settings.goal", v: 999999999 }, { t: "set", path: "settings.weights", v: { energy: 9 } },
    { t: "log.append", entry: entry("a1:1", { cell: -3 }) }, { t: "log.append", entry: entry("a1:1", { title: "x".repeat(61) }) },
    { t: "log.append", entry: entry("zzz:1") },
    { t: "lock.grant", lock: { target: "zone:a1:1" } },
    { t: "lock.request", target: "zone:b1:1", kind: "zone", cells: [1] },
    { t: "wat" },
  ];
  for (const op of bad) { const cid = a.op(op); const n = await a.waitFor((m) => m.t === "nack" && m.cid === cid); assert.ok(["invalid", "forbidden"].includes(n.reason), JSON.stringify(op)); }
  a.send({ t: "op", cid: "a1:99", op: { t: "log.append", entry: entry("a1:99", { note: "x".repeat(70000) }) } });
  assert.equal((await a.waitFor((m) => m.t === "nack" && m.cid === "a1:99")).reason, "invalid");
  a.send({ t: "op", cid: "b1:5", op: { t: "set", path: "settings.goal", v: 5 } });
  assert.equal((await a.waitFor((m) => m.t === "nack" && m.cid === "b1:5")).reason, "invalid");
  assert.equal(hub.doc.seq, seq, "nothing was sequenced");
  await a.close();
}));

test("12. ordering and roles: log.status rules, base can release others' locks, equipment is exclusive", () => withHub(async (hub) => {
  const [a] = await connect(hub, "a1"), [b] = await connect(hub, "b1"), [base] = await connect(hub, "ba", { role: "base", crew: "BASE" });
  a.op({ t: "log.append", entry: entry("a1:1", { severity: 3 }) });
  await a.waitFor((m) => m.t === "ack" && m.cid === "a1:1");
  const st = (c, status) => { const id = c.op({ t: "log.status", ref: "a1:1", status }); return c.waitFor((m) => (m.t === "ack" || m.t === "nack") && m.cid === id); };
  assert.equal((await st(b, "resolved")).reason, "forbidden");
  assert.equal((await st(a, "confirmed")).reason, "forbidden");
  assert.equal((await st(b, "confirmed")).t, "ack");
  assert.equal(hub.doc.log["a1:1"].status, "confirmed");
  assert.equal((await st(base, "resolved")).t, "ack");
  assert.equal(hub.doc.log["a1:1"].status, "resolved");
  const eq = { t: "lock.request", target: "equip:drill", kind: "equipment", profiles: ["foot"], reason: "Drilling", sticky: true };
  const c1 = a.op(eq); await a.waitFor((m) => m.t === "ack" && m.cid === c1);
  const c2 = b.op(eq); assert.equal((await b.waitFor((m) => m.t === "nack" && m.cid === c2)).reason, "held");
  const fence = hub.doc.locks["equip:drill"].fence;
  const c3 = b.op({ t: "lock.release", target: "equip:drill", fence }); assert.equal((await b.waitFor((m) => m.t === "nack" && m.cid === c3)).reason, "forbidden");
  const c4 = base.op({ t: "lock.release", target: "equip:drill", fence }); await base.waitFor((m) => m.t === "ack" && m.cid === c4);
  assert.equal(hub.doc.locks["equip:drill"], undefined);
  for (const c of [a, b, base]) await c.close();
}));

test("13. latency: ping RTT and op propagation A -> B over loopback (reported, not promised for Wi-Fi)", () => withHub(async (hub) => {
  const [a] = await connect(hub, "a1"), [b] = await connect(hub, "b1");
  const rtts = [], prop = [], N = 50;
  for (let i = 0; i < N; i++) {
    const t0 = performance.now(), id = `p${i}`;
    a.send({ t: "ping", id, c: Date.now() });
    await a.waitFor((m) => m.t === "pong" && m.id === id); rtts.push(performance.now() - t0);
    const t1 = performance.now(), eid = `a1:${i + 1}`;
    a.op({ t: "log.append", entry: entry(eid, { title: `E${i}` }) });
    await b.waitFor((m) => m.t === "op" && m.op.entry?.id === eid); prop.push(performance.now() - t1);
  }
  const q = (xs, p) => [...xs].sort((x, y) => x - y)[Math.min(xs.length - 1, Math.floor(xs.length * p))].toFixed(2);
  console.log(`  latency over ${N} samples (loopback): ping RTT p50 ${q(rtts, 0.5)} ms p95 ${q(rtts, 0.95)} ms · op A->B p50 ${q(prop, 0.5)} ms p95 ${q(prop, 0.95)} ms`);
  assert.ok(Number(q(prop, 0.95)) < 100);
  await a.close(); await b.close();
}, { logPerMin: Infinity }));

test("14. scenario runner: virtual crew move, the fault is logged as SIMULATED, the drill lock is held and released", async () => {
  const scn = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../web/data/scenarios/storm_eva.json"), "utf8"));
  scn.start.clock.rate = 20000;
  await withHub(async (hub) => {
    const [a] = await connect(hub, "a1");
    const fault = await a.waitFor((m) => m.t === "op" && m.op.entry?.section === "fault", 4000);
    assert.equal(fault.op.entry.tag, "SIMULATED"); assert.equal(fault.by.crew, "EV2");
    await a.waitFor((m) => m.t === "op" && m.op.t === "lock.grant" && m.op.lock.target === "equip:drill", 4000);
    await a.waitFor((m) => m.t === "op" && m.op.t === "lock.release", 4000);
    assert.equal(hub.doc.locks["equip:drill"], undefined);
    assert.equal(hub.doc.log["sim-EV2:e0"].status, "resolved");
    const p = hub.presence();
    assert.equal(p["sim-EV2"].sim, true); assert.equal(p["sim-ROVER"].kind, "vehicle");
    assert.equal(hub.doc.scenario.id, "storm_eva");
  }, { sim: scn, tickMs: 50 });
});

test("15. a torn last line is skipped on replay and the next append does not glue to it (seq and ops survive a second restart)", async () => {
  const dir = tmp(), run = async (fn) => { const h = await startHub({ port: 0, host: "127.0.0.1", dataDir: dir, minTtlMs: 100, tickMs: 50 }); try { return await fn(h); } finally { await h.close(); } };
  await run(async (h) => { const [a] = await connect(h, "a1"); a.op({ t: "log.append", entry: entry("a1:1") }); await a.waitFor((m) => m.t === "ack"); await a.close(); });
  fs.appendFileSync(path.join(dir, "ops.jsonl"), '{"seq":3,"ts":1,"by":{"deviceId":"a1"');
  await run(async (h) => { const [a] = await connect(h, "a1"); a.n = 2; a.op({ t: "log.append", entry: entry("a1:3") }); await a.waitFor((m) => m.t === "ack"); await a.close(); });
  await run((h) => { assert.deepEqual(Object.keys(h.doc.log), ["a1:1", "a1:3"]); assert.equal(h.doc.seq, 3); });
});

test("16. a second connection with the same deviceId replaces the first with close code 4001", () => withHub(async (hub) => {
  const [a] = await connect(hub, "a1"), code = new Promise((ok) => a.ws.once("close", (c) => ok(c)));
  const [a2] = await connect(hub, "a1");
  assert.equal(await code, 4001);
  assert.equal(hub.clients, 1);
  assert.equal(hub.presence().a1.online, true);
  await a2.close();
}));

test("17. a stale-fence release is a harmless ack; the lock stays", () => withHub(async (hub) => {
  const [a] = await connect(hub, "a1");
  const c1 = a.op(zone("a1", 1, [10, 11], { sticky: true })); await a.waitFor((m) => m.t === "ack" && m.cid === c1);
  const fence = hub.doc.locks["zone:a1:1"].fence;
  const c2 = a.op({ t: "lock.release", target: "zone:a1:1", fence: fence - 1 });
  assert.equal((await a.waitFor((m) => m.t === "ack" && m.cid === c2)).t, "ack");
  assert.ok(hub.doc.locks["zone:a1:1"]);
  const c3 = a.op({ t: "lock.release", target: "zone:a1:1", fence }); await a.waitFor((m) => m.t === "ack" && m.cid === c3);
  assert.equal(hub.doc.locks["zone:a1:1"], undefined);
  await a.close();
}));

test("18. a bad hello is nacked and closed: wrong version, bad or reserved deviceId, empty crew", () => withHub(async (hub) => {
  for (const hello of [{ v: 2, deviceId: "a1", crew: "EV1" }, { v: 1, deviceId: "bad id!", crew: "EV1" }, { v: 1, deviceId: "sim-EV2", crew: "EV1" }, { v: 1, deviceId: "hub", crew: "EV1" }, { v: 1, deviceId: "__proto__", crew: "EV1" }, { v: 1, deviceId: "a1", crew: "  " }]) {
    const c = await new Client(hub, "x").open(), closed = new Promise((ok) => c.ws.once("close", (code) => ok(code)));
    c.send({ t: "hello", ...hello });
    assert.equal((await c.waitFor((m) => m.t === "nack")).reason, "invalid");
    assert.equal(await closed, 4400, JSON.stringify(hello));
  }
  assert.equal(hub.clients, 0);
}));

test("19. two devices that say EV1 get distinct crew names; a reconnect keeps its own", () => withHub(async (hub) => {
  const [a] = await connect(hub, "a1", { crew: "EV1" }), [b, snapB] = await connect(hub, "b1", { crew: "EV1" });
  assert.equal(snapB.presence.a1.crew, "EV1"); assert.equal(snapB.presence.b1.crew, "EV1-2");
  const [a2, snapA] = await connect(hub, "a1", { crew: "EV1" });
  assert.equal(snapA.presence.a1.crew, "EV1");
  for (const c of [a, b, a2]) await c.close().catch(() => {});
}));

test("20. asset ids cannot be __proto__ or other prototype keys", () => withHub(async (hub) => {
  const [a] = await connect(hub, "a1");
  for (const id of ["__proto__", "constructor", "prototype"]) {
    const cid = a.op({ t: "set", path: `assets.${id}`, v: { id, kind: "supply", name: "x", cell: 5 } });
    assert.equal((await a.waitFor((m) => m.t === "nack" && m.cid === cid)).reason, "invalid", id);
  }
  assert.equal(Object.getPrototypeOf(hub.doc.assets), Object.prototype);
  await a.close();
}));

test("21. a zone of 9 000 cells fits one frame and is granted; 9 001 is refused", () => withHub(async (hub) => {
  const [a] = await connect(hub, "a1"), cells = (n) => Array.from({ length: n }, (_, i) => 50000 + i);
  const c1 = a.op(zone("a1", 1, cells(9000), { sticky: true }));
  assert.equal((await a.waitFor((m) => (m.t === "ack" || m.t === "nack") && m.cid === c1)).t, "ack");
  const c2 = a.op(zone("a1", 2, cells(9001).map((c) => c - 10000)));
  assert.equal((await a.waitFor((m) => m.t === "nack" && m.cid === c2)).reason, "invalid");
  await a.close();
}));

test("22. static files carry ETag + Last-Modified, answer 304, and big JSON is gzipped", () => withHub(async (hub) => {
  const req = (p, headers) => new Promise((ok, no) => http.get({ host: "127.0.0.1", port: hub.port, path: p, headers }, (r) => { const b = []; r.on("data", (d) => b.push(d)); r.on("end", () => ok({ status: r.statusCode, headers: r.headers, body: Buffer.concat(b) })); }).on("error", no));
  const p = "/data/jezero_cost_grid.json", plain = await req(p), gz = await req(p, { "accept-encoding": "gzip" });
  assert.ok(plain.headers.etag && plain.headers["last-modified"]);
  assert.equal(gz.headers["content-encoding"], "gzip");
  assert.ok(gz.body.length < plain.body.length / 3);
  assert.equal(JSON.parse((await import("node:zlib")).gunzipSync(gz.body)).meta.rows, JSON.parse(plain.body).meta.rows);
  assert.equal((await req(p, { "if-none-match": plain.headers.etag })).status, 304);
  assert.equal((await req(p, { "if-modified-since": plain.headers["last-modified"] })).status, 304);
  assert.equal((await req(p, { "if-none-match": '"other"' })).status, 200);
}));

test("23. Origin check: another site is refused, this hub's own origin and the Android WebView are accepted", () => withHub(async (hub) => {
  const tryOrigin = (origin) => new Promise((ok) => { const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/sync`, { headers: origin ? { Origin: origin } : {} }); ws.once("open", () => { ws.close(); ok(true); }); ws.once("error", () => ok(false)); });
  assert.equal(await tryOrigin("http://evil.example"), false);
  assert.equal(await tryOrigin("http://192.168.1.50:8090"), false);
  assert.equal(await tryOrigin(`http://127.0.0.1:${hub.port}`), true);
  for (const o of ["http://localhost", "https://localhost", "capacitor://localhost", null]) assert.equal(await tryOrigin(o), true, String(o));
}));

test("24. a plain crew device cannot change the shared world; the base can; a skewed clock is refused", () => withHub(async (hub) => {
  const [a] = await connect(hub, "a1"), [base] = await connect(hub, "ba", { role: "base", crew: "BASE" });
  const now = Date.now(), ck = { mode: "scenario", replaySol: null, anchorUtcMs: Date.UTC(2026, 5, 1), anchorWallMs: now, rate: 600, paused: false };
  const res = async (c, op) => { const cid = c.op(op); return (await c.waitFor((m) => (m.t === "ack" || m.t === "nack") && m.cid === cid)); };
  assert.equal((await res(a, { t: "set", path: "assets.base", v: null })).reason, "forbidden");
  assert.equal((await res(a, { t: "set", path: "clock", v: ck })).reason, "forbidden");
  assert.equal((await res(a, { t: "set", path: "settings.evaStartLtst", v: 10 })).t, "ack");
  assert.equal((await res(base, { t: "set", path: "clock", v: ck })).t, "ack");
  assert.equal((await res(base, { t: "set", path: "clock", v: { ...ck, anchorUtcMs: 8.64e15, anchorWallMs: 0, rate: 100000 } })).reason, "invalid");
  assert.equal((await res(base, { t: "set", path: "clock", v: { ...ck, anchorUtcMs: 8.64e15 } })).reason, "invalid");
  assert.equal((await res(base, { t: "set", path: "clock", v: { ...ck, anchorWallMs: now - 2 * 864e5 } })).reason, "invalid");
  assert.equal(hub.doc.assets.base.kind, "base");
  await Promise.all([a.close(), base.close()]);
}));

test("25. --token: the Base role is refused without it (close 4403) and accepted with it; /join stays on the hub computer", () => withHub(async (hub) => {
  const hello = (token) => new Promise((ok) => {
    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/sync`);
    ws.once("open", () => ws.send(JSON.stringify({ t: "hello", v: 1, deviceId: "ba", crew: "BASE", role: "base", kind: "base", lastSeq: 0, token })));
    ws.once("close", (code) => ok(code)); ws.on("message", (d) => { if (JSON.parse(d).t === "snapshot") { ws.close(); ok("snapshot"); } });
  });
  assert.equal(await hello(undefined), 4403);
  assert.equal(await hello("wrong"), 4403);
  assert.equal(await hello("s3cret"), "snapshot");
  const [a, snap] = await connect(hub, "a1");
  assert.ok(snap.doc);
  assert.match((await get(hub, "/join")).body, /token=s3cret/);
  await a.close();
}, { token: "s3cret" }));

test("26. quotas: 9th zone lock and 21st log entry in a minute from one device are refused", () => withHub(async (hub) => {
  const [a] = await connect(hub, "a1");
  const res = async (op) => { const cid = a.op(op); return (await a.waitFor((m) => (m.t === "ack" || m.t === "nack") && m.cid === cid)); };
  for (let i = 1; i <= 8; i++) assert.equal((await res(zone("a1", i, [100 + i], { sticky: true }))).t, "ack");
  assert.equal((await res(zone("a1", 9, [200], { sticky: true }))).reason, "limit");
  assert.equal((await res(zone("a1", 1, [101, 102], { sticky: true }))).t, "ack", "re-sending an existing zone is not a new one");
  for (let i = 1; i <= 20; i++) assert.equal((await res({ t: "log.append", entry: entry(`a1:${i}`) })).t, "ack");
  assert.equal((await res({ t: "log.append", entry: entry("a1:21") })).reason, "limit");
  await a.close();
}, { logPerMin: 20 }));

test("27. a device id held by a live socket from another address cannot be taken over", () => withHub(async (hub) => {
  const [a] = await connect(hub, "a1");
  const intruder = await new Promise((ok) => {
    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/sync`, { localAddress: "127.0.0.2" });
    ws.once("error", () => ok("no-127.0.0.2"));
    ws.once("open", () => ws.send(JSON.stringify({ t: "hello", v: 1, deviceId: "a1", crew: "X", role: "crew", kind: "astronaut", lastSeq: 0 })));
    ws.once("close", (code) => ok(code));
  });
  if (intruder !== "no-127.0.0.2") { assert.equal(intruder, 4409); assert.equal(a.ws.readyState, 1, "the owner stays connected"); }
  const [a2, snap] = await connect(hub, "a1");
  assert.ok(snap.doc);
  await Promise.all([a.close().catch(() => {}), a2.close()]);
}));
