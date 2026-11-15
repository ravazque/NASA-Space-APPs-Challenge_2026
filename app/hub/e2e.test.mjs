import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { applyOp } from "../web/sync-core.js";
import { overlay } from "../web/effects.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
import net from "node:net";
const freePort = () => new Promise((ok, no) => { const s = net.createServer().once("error", no).listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const PORT = await freePort(), URL_BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const grid = JSON.parse(fs.readFileSync(path.join(HERE, "../web/data/jezero_cost_grid.json"), "utf8")).meta;
const G = { rows: grid.rows, cols: grid.cols, cellM: grid.cell_m };

class Client {
  constructor(deviceId, crew) { Object.assign(this, { deviceId, crew, n: 0, frames: [], waiters: [], docAt: new Map() }); }
  async open() {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/sync`);
    this.ws.on("message", (d) => this.#on(JSON.parse(d)));
    await new Promise((ok, no) => { this.ws.once("open", ok); this.ws.once("error", no); });
    this.send({ t: "hello", v: 1, deviceId: this.deviceId, crew: this.crew, role: "crew", kind: "astronaut", lastSeq: 0 });
    await this.waitFor((m) => m.t === "snapshot");
    return this;
  }
  #on(m) {
    this.frames.push(m);
    if (m.t === "snapshot") { this.doc = m.doc; this.docAt.set(m.doc.seq, m.doc); }
    else if (m.t === "op") { this.doc = applyOp(this.doc, m.op, { seq: m.seq, by: m.by }); this.docAt.set(m.seq, this.doc); }
    this.waiters = this.waiters.filter((w) => !w(m));
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  op(op) { const cid = `${this.deviceId}:${++this.n}`; this.send({ t: "op", cid, op }); return cid; }
  waitFor(pred, ms = 3000) {
    const hit = this.frames.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((ok, no) => {
      const to = setTimeout(() => no(new Error(`timeout waiting for a frame (${pred}) ; got ${this.frames.map((f) => f.t + (f.nack ?? f.reason ?? "")).slice(-8)}`)), ms);
      this.waiters.push((m) => (pred(m) ? (clearTimeout(to), ok(m), true) : false));
    });
  }
  blocked(cell, profile = "foot") {
    const entries = this.doc.logOrder.map((id) => this.doc.log[id]), locks = Object.values(this.doc.locks);
    const { mult } = overlay({ entries, locks, me: { deviceId: this.deviceId }, profile, ...G, nowUtcMs: Date.now() });
    return mult[cell];
  }
  close() { this.ws.close(); return new Promise((r) => this.ws.once("close", r)); }
}

async function waitHealth(ms = 8000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(100)) {
    try { const r = await fetch(`${URL_BASE}/health`); if (r.ok) return r.json(); } catch { }
  }
  throw new Error(`hub did not answer on :${PORT} (is the port busy?)`);
}

test("LAN end to end: sim hub, two clients, lease expiry, hazard report, convergence", { timeout: 60000 }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "ariadne-e2e-"));
  const hub = spawn(process.execPath, [path.join(HERE, "server.mjs"), "--port", String(PORT), "--host", "127.0.0.1", "--data", data, "--reset", "--sim", "storm_eva"], { stdio: "ignore" });
  const exited = new Promise((r) => hub.once("exit", r));
  let a, b;
  try {
    const health = await waitHealth();
    assert.equal(health.ariadne, true);
    assert.equal(health.sim, "storm_eva");

    a = await new Client("e2e-a", "EV1").open();
    b = await new Client("e2e-b", "EV2").open();
    for (const c of [a, b]) await c.waitFor((m) => (m.t === "snapshot" && Object.keys(m.presence).some((id) => id.startsWith("sim-"))) || (m.t === "presence" && m.deviceId?.startsWith("sim-")), 4000);

    const cells = [20, 21, 22, 20 + G.cols, 21 + G.cols];
    const target = `zone:e2e-a:${Date.now() % 1e9}`;
    const c1 = a.op({ t: "lock.request", target, kind: "zone", cells, profiles: ["foot", "vehicle", "cargo"], reason: "Rockfall", sticky: false, ttlMs: 1000 });
    const ack = await a.waitFor((m) => m.t === "ack" && m.cid === c1);
    await b.waitFor((m) => m.t === "op" && m.op.t === "lock.grant" && m.op.lock.target === target);
    assert.equal(b.blocked(21), Infinity, "B routes around A's zone");
    assert.equal(a.blocked(21), 1, "A's own lock never blocks A");
    const c2 = b.op({ t: "lock.request", target: `zone:e2e-b:${Date.now() % 1e9}`, kind: "zone", cells: [22], profiles: ["foot"], reason: "Same spot", sticky: false });
    assert.equal((await b.waitFor((m) => m.t === "nack" && m.cid === c2)).reason, "overlap");
    assert.ok(b.doc.locks[target].fence >= ack.seq - 1);

    const hazardCell = (G.rows >> 1) * G.cols + (G.cols >> 1);
    const c3 = b.op({ t: "log.append", entry: { id: "e2e-b:1", section: "hazard", severity: 3, cell: hazardCell, radius_m: 40, title: "Collapsed rim", note: "", data: { kind: "rockfall" }, utcMs: Date.now() } });
    await b.waitFor((m) => m.t === "ack" && m.cid === c3);
    await a.waitFor((m) => m.t === "op" && m.op.entry?.id === "e2e-b:1");
    assert.equal(a.doc.log["e2e-b:1"].author.deviceId, "e2e-b");
    assert.equal(a.doc.log["e2e-b:1"].tag, "REPORTED");
    for (const c of [a, b]) for (const profile of ["foot", "vehicle", "cargo"]) assert.equal(c.blocked(hazardCell, profile), Infinity, `hazard blocks ${profile} for ${c.deviceId}`);

    await a.waitFor((m) => m.t === "op" && m.op.t === "lock.expired" && m.op.target === target, 14000);
    await b.waitFor((m) => m.t === "op" && m.op.t === "lock.expired" && m.op.target === target);
    assert.equal(b.doc.locks[target], undefined);
    assert.equal(b.blocked(21), 1, "B is free once the lease expired");
    assert.equal(b.blocked(hazardCell), Infinity, "the hazard is not a lease: it stays");

    await sleep(500);
    const seq = Math.min(a.doc.seq, b.doc.seq);
    assert.deepEqual(a.docAt.get(seq), b.docAt.get(seq));
    const lines = (await (await fetch(`${URL_BASE}/log.jsonl`)).text()).trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(lines.length >= seq - 1, "hub log holds every sequenced op");
    assert.ok(lines.some((r) => r.op?.t === "lock.expired") && lines.some((r) => r.op?.entry?.id === "e2e-b:1"));
  } finally {
    await Promise.all([a?.close().catch(() => {}), b?.close().catch(() => {})]);
    hub.kill("SIGTERM");
    await Promise.race([exited, sleep(3000)]);
    fs.rmSync(data, { recursive: true, force: true });
  }
});
