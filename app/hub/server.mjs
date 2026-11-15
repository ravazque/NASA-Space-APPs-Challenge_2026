import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { WebSocketServer } from "ws";
import { initialDoc, applyOp, decide, sweep, renew } from "../web/sync-core.js";
import { simStartOps, simOps, simPresence, simFrom, scenarioSeconds, simStepper } from "../web/sim.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "../web");
const require = createRequire(import.meta.url);
const HUB_BY = { deviceId: "hub", crew: "HUB" };
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".ico": "image/x-icon", ".jsonl": "application/x-ndjson" };
const NOCACHE = new Set([".html", ".js", ".mjs", ".css", ".json"]);
const GZIP = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".txt"]);
const RESERVED = /^(sim-|hub$|__proto__$)/;

let QR = null;
try { QR = { Code: require("qrcode-terminal/vendor/QRCode"), Level: require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel") }; } catch { }
export function qrSvg(text) {
  if (!QR) return null;
  const q = new QR.Code(-1, QR.Level.M);
  q.addData(text); q.make();
  const n = q.getModuleCount(), pad = 4;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + pad} ${r + pad}h1v1h-1z`;
  const s = n + 2 * pad;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" shape-rendering="crispEdges" role="img" aria-label="QR ${text}"><rect width="${s}" height="${s}" fill="#fff"/><path d="${d}" fill="#1a1a1a"/></svg>`;
}
const privateRank = (a) => (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a) ? 0 : 1);
export function lanIps() {
  return Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254."))
    .map((i) => i.address).sort((a, b) => privateRank(a) - privateRank(b));
}
const isLoopback = (a = "") => a === "::1" || a.startsWith("127.") || a.startsWith("::ffff:127.");
const originOk = (req) => {
  const o = req.headers.origin;
  if (!o) return true;
  if (o.replace(/^[a-z]+:\/\//, "") === req.headers.host) return true;
  try { const u = new URL(o); return u.hostname === "localhost" && ["http:", "https:", "capacitor:"].includes(u.protocol); } catch { return false; }
};

export async function startHub(opts = {}) {
  const o = { port: 8090, host: "0.0.0.0", dataDir: path.resolve(HERE, "data"), sim: null, reset: false, token: null, logPerMin: 30, minTtlMs: 10000, tickMs: 1000, quiet: true, ...opts };
  const grid = JSON.parse(fs.readFileSync(path.join(WEB, "data/jezero_cost_grid.json"), "utf8")).meta;
  const g = { rows: grid.rows, cols: grid.cols }, env = { grid: g, minTtlMs: o.minTtlMs, guarded: true };
  const log = (...a) => { if (!o.quiet) console.log(...a); };

  fs.mkdirSync(o.dataDir, { recursive: true });
  const file = path.join(o.dataDir, "ops.jsonl");
  if (o.reset && fs.existsSync(file)) fs.renameSync(file, path.join(o.dataDir, `ops-${Date.now()}.jsonl.bak`));
  let doc = initialDoc(Date.now());
  const cids = new Map();
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { const r = JSON.parse(line); doc = applyOp(doc, r.op, { seq: r.seq, by: r.by }); if (r.cid) cids.set(r.cid, r.seq); } catch { }
    }
    if (text && !text.endsWith("\n")) fs.appendFileSync(file, "\n");
    const now = Date.now();
    for (const L of Object.values(doc.locks)) if (L.expiresAt != null) doc = { ...doc, locks: { ...doc.locks, [L.target]: { ...L, expiresAt: now + (L.ttlMs ?? 30000) } } };
  }

  const clients = new Map();
  const presence = new Map();
  const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
  const broadcast = (m) => { const s = JSON.stringify(m); for (const c of clients.values()) if (c.ws.readyState === 1) c.ws.send(s); };
  const setPresence = (p) => { presence.set(p.deviceId, p); broadcast({ t: "presence", ...p }); };

  function sequence(op, by, cid) {
    const seq = doc.seq + 1;
    fs.appendFileSync(file, `${JSON.stringify({ seq, ts: Date.now(), by, cid: cid ?? null, op })}\n`);
    doc = applyOp(doc, op, { seq, by });
    if (cid) cids.set(cid, seq);
    broadcast({ t: "op", seq, op, by, ...(cid ? { cid } : {}) });
    return seq;
  }
  function submitAs(from, rawOp, cid) {
    const r = decide(doc, { t: "op", cid, op: rawOp }, from, Date.now(), env);
    if (r.nack) return r;
    const by = { deviceId: from.deviceId, crew: from.crew };
    let first = null;
    for (const op of r.ops) { const s = sequence(op, by, first == null ? cid : null); first ??= s; }
    return { seq: first ?? doc.seq };
  }

  const habitatCell = grid.sites.three_forks.cell[0] * grid.cols + grid.sites.three_forks.cell[1];
  if (doc.seq === 0) sequence({ t: "set", path: "assets.base", v: { id: "base", kind: "base", name: "Habitat", cell: habitatCell, tag: "SIMULATED" } }, HUB_BY, null);

  let scn = null, simData = null, step = simStepper();
  if (o.sim) {
    scn = typeof o.sim === "object" ? o.sim : JSON.parse(fs.readFileSync(path.join(WEB, `data/scenarios/${o.sim}.json`), "utf8"));
    const trav = JSON.parse(fs.readFileSync(path.join(WEB, "data/traverse_cells.json"), "utf8"));
    simData = { rows: grid.rows, cols: grid.cols, cellM: grid.cell_m, traverse: trav.map(([r, c]) => r * grid.cols + c) };
    if (doc.scenario.id !== scn.id || o.reset) { for (const op of simStartOps(scn, simData, Date.now())) submitAs(simFrom(op), op); }
    else step = simStepper(scenarioSeconds(doc, Date.now()));
  }
  function simTick() {
    if (!scn || !doc.scenario.running || doc.scenario.id !== scn.id) return;
    const now = Date.now(), tS = scenarioSeconds(doc, now);
    const span = step(doc.clock, tS);
    for (const op of span ? simOps(scn, simData, span[0], span[1], doc.scenario.startUtcMs) : []) {
      const r = submitAs(simFrom(op), op);
      if (r.nack) console.warn(`sim: ${op.t} refused (${r.nack})`);
    }
    for (const p of simPresence(scn, simData, tS)) setPresence({ ...p, ts: now });
  }

  const cellOk = (v) => Number.isInteger(v) && v >= 0 && v < g.rows * g.cols;
  const KINDS = ["astronaut", "vehicle", "base"], ROLES = ["crew", "base"];
  const fromOf = (c) => ({ deviceId: c.deviceId, crew: c.crew, role: c.role });

  function onMessage(ws, raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return send(ws, { t: "nack", reason: "invalid" }); }
    const c = ws.client;
    if (m?.t === "ping") return send(ws, { t: "pong", id: m.id, c: m.c, h: Date.now() });
    if (m?.t === "hello") {
      const crew = typeof m.crew === "string" ? m.crew.trim().slice(0, 12) : "";
      if (m.v !== 1 || !/^[\w-]{1,24}$/.test(m.deviceId ?? "") || RESERVED.test(m.deviceId) || !crew || !ROLES.includes(m.role ?? "crew")) { send(ws, { t: "nack", reason: "invalid" }); return ws.close(4400, "bad hello"); }
      const role = m.role ?? "crew";
      if (role === "base" && o.token && m.token !== o.token) { send(ws, { t: "nack", reason: "forbidden" }); return ws.close(4403, "token required for base"); }
      const old = clients.get(m.deviceId);
      if (old && old.ws !== ws) {
        if (old.ws.readyState === 1 && old.alive && old.addr !== ws.addr) { send(ws, { t: "nack", reason: "forbidden" }); return ws.close(4409, "device id in use"); }
        old.replaced = true; old.ws.close(4001, "replaced");
      }
      const taken = (n) => [...clients.values()].some((x) => x.deviceId !== m.deviceId && x.crew.toLowerCase() === n.toLowerCase());
      let crewName = crew;
      for (let i = 2; taken(crewName); i++) crewName = `${crew.slice(0, 12 - String(i).length - 1)}-${i}`;
      const cl = { ws, deviceId: m.deviceId, crew: crewName, role, kind: KINDS.includes(m.kind) ? m.kind : "astronaut", alive: true, addr: ws.addr, logTimes: [], lastPresence: 0 };
      ws.client = cl; clients.set(cl.deviceId, cl);
      const prev = presence.get(cl.deviceId);
      setPresence({ deviceId: cl.deviceId, crew: crewName, role: cl.role, kind: cl.kind, cell: prev?.cell ?? null, online: true, ts: Date.now(), sim: false });
      return send(ws, { t: "snapshot", seq: doc.seq, doc, presence: Object.fromEntries(presence), hubNow: Date.now(), scenario: doc.scenario });
    }
    if (!c) return send(ws, { t: "nack", reason: "invalid" });
    if (m?.t === "op") {
      const cid = m.cid;
      if (typeof cid !== "string" || cid.length > 48 || !cid.startsWith(`${c.deviceId}:`) || raw.length > 65536) return send(ws, { t: "nack", cid, reason: "invalid" });
      if (cids.has(cid)) return send(ws, { t: "ack", cid, seq: cids.get(cid) });
      if (m.op?.t === "log.append") {
        const now = Date.now();
        c.logTimes = c.logTimes.filter((x) => now - x < 60000);
        if (c.logTimes.length >= o.logPerMin) return send(ws, { t: "nack", cid, reason: "limit" });
        c.logTimes.push(now);
      }
      let r;
      try { r = submitAs(fromOf(c), m.op, cid); } catch (e) { console.error("hub write error:", e); r = { nack: "invalid" }; }
      return send(ws, r.nack ? { t: "nack", cid, reason: r.nack, ...(r.holder ? { holder: r.holder } : {}) } : { t: "ack", cid, seq: r.seq });
    }
    if (m?.t === "renew") { if (typeof m.target === "string") doc = renew(doc, m.target, fromOf(c), Date.now()); return; }
    if (m?.t === "presence") {
      const p = presence.get(c.deviceId), now = Date.now();
      if (now - c.lastPresence < 100) return;
      c.lastPresence = now;
      if (!p || !(m.cell === null || cellOk(m.cell))) return;
      return setPresence({ ...p, cell: m.cell, kind: KINDS.includes(m.kind) ? m.kind : p.kind, online: true, ts: Date.now() });
    }
    return send(ws, { t: "nack", reason: "invalid" });
  }

  const tokenQ = o.token ? `?token=${encodeURIComponent(o.token)}` : "";
  const lanUrl = (ip = lanIps()[0]) => `http://${ip ?? "localhost"}:${server.address().port}/${tokenQ}`;
  function joinPage() {
    const ips = lanIps(), urls = ips.length ? ips.map((ip) => lanUrl(ip)) : [lanUrl()];
    const blocks = urls.map((url) => { const hp = url.replace(/^http:\/\//, "").replace(/\/.*$/, ""); return `<div class="qr">${qrSvg(url) ?? ""}</div><p class="url">${hp}</p>`; }).join("");
    const hostPort = urls[0].replace(/^http:\/\//, "").replace(/\/.*$/, "");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ARIADNE · Join</title>
<style>body{font:16px/1.4 Barlow,system-ui,sans-serif;background:#f2f1ec;color:#1a1a1a;margin:0;padding:1rem;text-align:center}h1{letter-spacing:.12em;margin:.5rem 0}
.qr{width:min(80vw,22rem);background:#fff;border:1px solid #1a1a1a;margin:1rem auto;display:block}.url{font-size:1.75rem;font-weight:700;word-break:break-all}p{margin:.5rem 0}</style></head>
<body><h1>ARIADNE</h1><p>Join the field network · Únete a la red de campo</p>${blocks}
<p>Android app: enter <b>${hostPort}</b> · App Android: introduce <b>${hostPort}</b></p></body></html>`;
  }
  const gzCache = new Map();
  async function gzipped(f, etag) {
    const hit = gzCache.get(f);
    if (hit?.etag === etag) return hit.buf;
    const buf = await new Promise((ok, no) => fs.readFile(f, (e, d) => (e ? no(e) : zlib.gzip(d, (e2, z) => (e2 ? no(e2) : ok(z))))));
    gzCache.set(f, { etag, buf });
    return buf;
  }
  function serveStatic(req, res) {
    let p;
    try { p = decodeURIComponent(req.url.split("?")[0]); } catch { res.writeHead(400).end("bad request"); return; }
    if (p.includes("\0")) { res.writeHead(400).end("bad request"); return; }
    let file = path.join(WEB, p);
    if (file !== WEB && !file.startsWith(WEB + path.sep)) { res.writeHead(403).end("forbidden"); return; }
    fs.stat(file, (err, st) => {
      if (!err && st.isDirectory()) { file = path.join(file, "index.html"); }
      fs.stat(file, (e2, st2) => {
        if (e2 || !st2.isFile()) { res.writeHead(404).end("not found"); return; }
        const ext = path.extname(file).toLowerCase();
        const cache = p.startsWith("/tiles/") ? "max-age=86400" : NOCACHE.has(ext) ? "no-cache" : "max-age=3600";
        const etag = `"${st2.size.toString(16)}-${Math.floor(st2.mtimeMs).toString(16)}"`, lastMod = st2.mtime.toUTCString();
        const h = { "Content-Type": MIME[ext] ?? "application/octet-stream", "Cache-Control": cache, ETag: etag, "Last-Modified": lastMod, Vary: "Accept-Encoding" };
        const inm = req.headers["if-none-match"], ims = Date.parse(req.headers["if-modified-since"] ?? "");
        if (inm ? inm.split(",").some((x) => x.trim().replace(/^W\//, "") === etag) : ims >= Math.floor(st2.mtimeMs / 1000) * 1000) { res.writeHead(304, h).end(); return; }
        const gz = GZIP.has(ext) && st2.size > 1024 && /\bgzip\b/.test(req.headers["accept-encoding"] ?? "");
        if (!gz) {
          res.writeHead(200, { ...h, "Content-Length": st2.size });
          if (req.method === "HEAD") res.end(); else fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
          return;
        }
        gzipped(file, etag).then((buf) => {
          res.writeHead(200, { ...h, "Content-Encoding": "gzip", "Content-Length": buf.length });
          res.end(req.method === "HEAD" ? undefined : buf);
        }, () => res.destroy());
      });
    });
  }
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end("method not allowed"); return; }
    const url = req.url.split("?")[0];
    if (url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ariadne: true, version: 2, seq: doc.seq, clients: clients.size, uptimeS: Math.round(process.uptime()), sim: scn?.id ?? null })); return;
    }
    if ((url === "/join" || url === "/qr") && o.token && !isLoopback(req.socket.remoteAddress)) { res.writeHead(403).end("forbidden: open this page on the hub computer"); return; }
    if (url === "/join") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(joinPage()); return; }
    if (url === "/qr") {
      const svg = qrSvg(lanUrl());
      res.writeHead(svg ? 200 : 404, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" }).end(svg ?? ""); return;
    }
    if (url === "/log.jsonl") {
      res.writeHead(200, { "Content-Type": MIME[".jsonl"], "Content-Disposition": 'attachment; filename="ariadne-log.jsonl"', "Cache-Control": "no-store" });
      fs.existsSync(file) ? fs.createReadStream(file).on("error", () => res.destroy()).pipe(res) : res.end(); return;
    }
    serveStatic(req, res);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  server.on("upgrade", (req, socket, head) => {
    if (req.url.split("?")[0] !== "/sync" || !originOk(req)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => { ws.addr = req.socket.remoteAddress; wss.emit("connection", ws); });
  });
  wss.on("connection", (ws) => {
    ws.on("message", (data) => { try { onMessage(ws, data.toString()); } catch (e) { console.error("hub message error:", e); } });
    ws.on("pong", () => { if (ws.client) ws.client.alive = true; });
    ws.on("error", () => {});
    ws.on("close", () => {
      const c = ws.client;
      if (!c || c.replaced) return;
      clients.delete(c.deviceId);
      const p = presence.get(c.deviceId);
      if (p) setPresence({ ...p, online: false, ts: Date.now() });
    });
  });

  let ticks = 0;
  const timer = setInterval(() => {
    try {
      const now = Date.now();
      for (const op of sweep(doc, now)) sequence(op, HUB_BY, null);
      simTick();
      for (const [id, p] of presence) if (!p.online && !p.sim && now - p.ts > 600000) { presence.delete(id); broadcast({ t: "presence", deviceId: id, online: false, gone: true }); }
      if (++ticks % 5 === 0) for (const c of clients.values()) { if (!c.alive) c.ws.terminate(); else { c.alive = false; c.ws.ping(); } }
    } catch (e) { console.error("hub tick error:", e); }
  }, o.tickMs);

  await new Promise((ok, no) => { server.once("error", no); server.listen(o.port, o.host, ok); });
  const port = server.address().port;
  return {
    port, url: `http://localhost:${port}`, file, lanUrl,
    get doc() { return doc; }, get clients() { return clients.size; }, presence: () => Object.fromEntries(presence),
    close: () => new Promise((ok) => { clearInterval(timer); for (const c of clients.values()) c.ws.terminate(); wss.close(); server.close(() => ok()); server.closeAllConnections?.(); }),
    log,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2), arg = (k, d) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : d; };
  const port = Number(arg("port", process.env.PORT ?? 8090)), host = arg("host", "0.0.0.0");
  const dataDir = path.resolve(arg("data", process.env.HUB_DATA ?? path.join(HERE, "data")));
  const sim = arg("sim", process.env.SIM) || null, token = arg("token", process.env.HUB_TOKEN) || null;
  const hub = await startHub({ port, host, dataDir, sim: sim && sim !== "none" ? sim : null, reset: a.includes("--reset"), token, quiet: false }).catch((e) => {
    console.error(e.code === "EADDRINUSE" ? `Port ${port} is already in use. Try: node app/hub/server.mjs --port ${port + 1}` : e.message);
    process.exit(1);
  });
  const ips = lanIps();
  console.log(`\nARIADNE hub · ${hub.doc.seq} ops in log · data ${path.relative(process.cwd(), dataDir) || "."}${hub.doc.scenario.running ? ` · sim ${hub.doc.scenario.id}` : ""}`);
  console.log(`  This computer   http://localhost:${hub.port}/`);
  for (const ip of ips) console.log(`  On the network  http://${ip}:${hub.port}/`);
  if (!ips.length) console.log("  (no network address found: connect this laptop to the Wi-Fi the phones use)");
  console.log(`  Join page + QR  http://localhost:${hub.port}/join   ·   Android app: enter ${ips[0] ?? "<ip>"}:${hub.port}`);
  console.log(token ? "  Base role needs the join token (it is inside the QR URL; share it only with the base crew)\n" : "  No --token: any device on this network can pick the Base role (see docs/lan-sync.md, Trust boundary)\n");
  if (ips.length) { try { const qr = (await import("qrcode-terminal")).default; for (const ip of ips) { if (ips.length > 1) console.log(`  QR for ${ip}`); qr.generate(hub.lanUrl(ip), { small: true }); } } catch { } }
  process.on("SIGINT", async () => { await hub.close(); process.exit(0); });
  process.on("SIGTERM", async () => { await hub.close(); process.exit(0); });
}
