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
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
  ".jsonl": "application/x-ndjson",
};
const NOCACHE = new Set([".html", ".js", ".mjs", ".css", ".json"]);
const GZIP = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".txt"]);
const RESERVED = /^(sim-|hub$|__proto__$)/;

let QR = null;
try {
  QR = {
    Code: require("qrcode-terminal/vendor/QRCode"),
    Level: require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel"),
  };
} catch {}

export function qrSvg(text) {
  if (!QR) return null;
  const qr = new QR.Code(-1, QR.Level.M);
  qr.addData(text);
  qr.make();
  const modules = qr.getModuleCount();
  const margin = 4;
  let darkModules = "";
  for (let r = 0; r < modules; r++) {
    for (let c = 0; c < modules; c++) {
      if (qr.isDark(r, c)) darkModules += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }
  const size = modules + 2 * margin;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QR ${text}">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>` +
    `<path d="${darkModules}" fill="#1a1a1a"/></svg>`
  );
}

const PRIVATE_ADDRESS = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/;

function privateRank(address) {
  return PRIVATE_ADDRESS.test(address) ? 0 : 1;
}

export function lanIps() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === "IPv4" && !iface.internal)
    .filter((iface) => !iface.address.startsWith("169.254."))
    .map((iface) => iface.address)
    .sort((a, b) => privateRank(a) - privateRank(b));
}

function isLoopback(address = "") {
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin.replace(/^[a-z]+:\/\//, "") === req.headers.host) return true;
  try {
    const url = new URL(origin);
    const allowedProtocols = ["http:", "https:", "capacitor:"];
    return url.hostname === "localhost" && allowedProtocols.includes(url.protocol);
  } catch {
    return false;
  }
}

function hostPortOf(url) {
  return url.replace(/^http:\/\//, "").replace(/\/.*$/, "");
}

const DEFAULT_OPTIONS = {
  port: 8090,
  host: "0.0.0.0",
  dataDir: path.resolve(HERE, "data"),
  sim: null,
  reset: false,
  token: null,
  logPerMin: 30,
  minTtlMs: 10000,
  tickMs: 1000,
  quiet: true,
};
const DEFAULT_LOCK_TTL_MS = 30000;
const MAX_CREW_LENGTH = 12;
const MAX_CID_LENGTH = 48;
const MAX_OP_MESSAGE_LENGTH = 65536;
const MAX_WS_PAYLOAD = 1 << 20;
const PRESENCE_MIN_INTERVAL_MS = 100;
const PRESENCE_EXPIRY_MS = 600000;
const LOG_WINDOW_MS = 60000;
const HEARTBEAT_EVERY_TICKS = 5;
const WS_OPEN = 1;
const KINDS = ["astronaut", "vehicle", "base"];
const ROLES = ["crew", "base"];

function badRequest(res) {
  res.writeHead(400).end("bad request");
}

function joinPageHtml(urls) {
  const blocks = urls
    .map((url) => {
      const hostPort = hostPortOf(url);
      return `<div class="qr">${qrSvg(url) ?? ""}</div><p class="url">${hostPort}</p>`;
    })
    .join("");
  const hostPort = hostPortOf(urls[0]);
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>ARIADNE · Join</title>\n" +
    "<style>" +
    "body{font:16px/1.4 Barlow,system-ui,sans-serif;background:#f2f1ec;color:#1a1a1a;" +
    "margin:0;padding:1rem;text-align:center}" +
    "h1{letter-spacing:.12em;margin:.5rem 0}\n" +
    ".qr{width:min(80vw,22rem);background:#fff;border:1px solid #1a1a1a;" +
    "margin:1rem auto;display:block}" +
    ".url{font-size:1.75rem;font-weight:700;word-break:break-all}" +
    "p{margin:.5rem 0}" +
    "</style></head>\n" +
    "<body><h1>ARIADNE</h1><p>Join the field network · Únete a la red de campo</p>" +
    `${blocks}\n` +
    `<p>Android app: enter <b>${hostPort}</b> · App Android: introduce <b>${hostPort}</b></p>` +
    "</body></html>"
  );
}

function loadScenario(sim) {
  if (typeof sim === "object") return sim;
  const file = path.join(WEB, `data/scenarios/${sim}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function makeEtag(stat) {
  return `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

function cacheControlFor(urlPath, ext) {
  if (urlPath.startsWith("/tiles/")) return "max-age=86400";
  if (NOCACHE.has(ext)) return "no-cache";
  return "max-age=3600";
}

function isNotModified(req, etag, stat) {
  const ifNoneMatch = req.headers["if-none-match"];
  if (ifNoneMatch) {
    return ifNoneMatch.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag);
  }
  const ifModifiedSince = Date.parse(req.headers["if-modified-since"] ?? "");
  return ifModifiedSince >= Math.floor(stat.mtimeMs / 1000) * 1000;
}

function streamFile(file, res) {
  fs.createReadStream(file)
    .on("error", () => res.destroy())
    .pipe(res);
}

export async function startHub(opts = {}) {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  const grid = JSON.parse(fs.readFileSync(path.join(WEB, "data/jezero_cost_grid.json"), "utf8")).meta;
  const gridSize = { rows: grid.rows, cols: grid.cols };
  const env = { grid: gridSize, minTtlMs: options.minTtlMs, guarded: true };
  const log = (...args) => {
    if (!options.quiet) console.log(...args);
  };

  fs.mkdirSync(options.dataDir, { recursive: true });
  const file = path.join(options.dataDir, "ops.jsonl");
  if (options.reset && fs.existsSync(file)) {
    fs.renameSync(file, path.join(options.dataDir, `ops-${Date.now()}.jsonl.bak`));
  }

  let doc = initialDoc(Date.now());
  const cids = new Map();

  function renewLocksAfterRestart() {
    const now = Date.now();
    for (const lock of Object.values(doc.locks)) {
      if (lock.expiresAt == null) continue;
      const renewed = { ...lock, expiresAt: now + (lock.ttlMs ?? DEFAULT_LOCK_TTL_MS) };
      doc = { ...doc, locks: { ...doc.locks, [lock.target]: renewed } };
    }
  }

  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        doc = applyOp(doc, record.op, { seq: record.seq, by: record.by });
        if (record.cid) cids.set(record.cid, record.seq);
      } catch {}
    }
    if (text && !text.endsWith("\n")) fs.appendFileSync(file, "\n");
    renewLocksAfterRestart();
  }

  const clients = new Map();
  const presence = new Map();

  function send(ws, message) {
    if (ws.readyState === WS_OPEN) ws.send(JSON.stringify(message));
  }

  function broadcast(message) {
    const payload = JSON.stringify(message);
    for (const client of clients.values()) {
      if (client.ws.readyState === WS_OPEN) client.ws.send(payload);
    }
  }

  function setPresence(entry) {
    presence.set(entry.deviceId, entry);
    broadcast({ t: "presence", ...entry });
  }

  function sequence(op, by, cid) {
    const seq = doc.seq + 1;
    const record = { seq, ts: Date.now(), by, cid: cid ?? null, op };
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
    doc = applyOp(doc, op, { seq, by });
    if (cid) cids.set(cid, seq);
    broadcast({ t: "op", seq, op, by, ...(cid ? { cid } : {}) });
    return seq;
  }

  function submitAs(from, rawOp, cid) {
    const result = decide(doc, { t: "op", cid, op: rawOp }, from, Date.now(), env);
    if (result.nack) return result;
    const by = { deviceId: from.deviceId, crew: from.crew };
    let firstSeq = null;
    for (const op of result.ops) {
      const seq = sequence(op, by, firstSeq == null ? cid : null);
      firstSeq ??= seq;
    }
    return { seq: firstSeq ?? doc.seq };
  }

  const habitat = grid.sites.three_forks.cell;
  if (doc.seq === 0) {
    const base = {
      id: "base",
      kind: "base",
      name: "Habitat",
      cell: habitat[0] * grid.cols + habitat[1],
      tag: "SIMULATED",
    };
    sequence({ t: "set", path: "assets.base", v: base }, HUB_BY, null);
  }

  let scenario = null;
  let simData = null;
  let step = simStepper();
  if (options.sim) {
    scenario = loadScenario(options.sim);
    const traverse = JSON.parse(fs.readFileSync(path.join(WEB, "data/traverse_cells.json"), "utf8"));
    simData = {
      rows: grid.rows,
      cols: grid.cols,
      cellM: grid.cell_m,
      traverse: traverse.map(([r, c]) => r * grid.cols + c),
    };
    if (doc.scenario.id !== scenario.id || options.reset) {
      for (const op of simStartOps(scenario, simData, Date.now())) {
        submitAs(simFrom(op), op);
      }
    } else {
      step = simStepper(scenarioSeconds(doc, Date.now()));
    }
  }

  function simTick() {
    if (!scenario || !doc.scenario.running || doc.scenario.id !== scenario.id) return;
    const now = Date.now();
    const seconds = scenarioSeconds(doc, now);
    const span = step(doc.clock, seconds);
    const ops = span ? simOps(scenario, simData, span[0], span[1], doc.scenario.startUtcMs) : [];
    for (const op of ops) {
      const result = submitAs(simFrom(op), op);
      if (result.nack) console.warn(`sim: ${op.t} refused (${result.nack})`);
    }
    for (const entry of simPresence(scenario, simData, seconds)) {
      setPresence({ ...entry, ts: now });
    }
  }

  const isValidCell = (cell) =>
    Number.isInteger(cell) && cell >= 0 && cell < gridSize.rows * gridSize.cols;
  const fromOf = (client) => ({ deviceId: client.deviceId, crew: client.crew, role: client.role });

  function isValidHello(message) {
    const crew = typeof message.crew === "string" ? message.crew.trim().slice(0, MAX_CREW_LENGTH) : "";
    return (
      message.v === 1 &&
      /^[\w-]{1,24}$/.test(message.deviceId ?? "") &&
      !RESERVED.test(message.deviceId) &&
      crew !== "" &&
      ROLES.includes(message.role ?? "crew")
    );
  }

  function uniqueCrewName(crew, deviceId) {
    const isTaken = (name) =>
      [...clients.values()].some(
        (other) => other.deviceId !== deviceId && other.crew.toLowerCase() === name.toLowerCase(),
      );
    let name = crew;
    for (let i = 2; isTaken(name); i++) {
      const keep = MAX_CREW_LENGTH - String(i).length - 1;
      name = `${crew.slice(0, keep)}-${i}`;
    }
    return name;
  }

  function handleHello(ws, message) {
    if (!isValidHello(message)) {
      send(ws, { t: "nack", reason: "invalid" });
      return ws.close(4400, "bad hello");
    }
    const crew = message.crew.trim().slice(0, MAX_CREW_LENGTH);
    const role = message.role ?? "crew";
    if (role === "base" && options.token && message.token !== options.token) {
      send(ws, { t: "nack", reason: "forbidden" });
      return ws.close(4403, "token required for base");
    }
    const previous = clients.get(message.deviceId);
    if (previous && previous.ws !== ws) {
      const inUseElsewhere =
        previous.ws.readyState === WS_OPEN && previous.alive && previous.addr !== ws.addr;
      if (inUseElsewhere) {
        send(ws, { t: "nack", reason: "forbidden" });
        return ws.close(4409, "device id in use");
      }
      previous.replaced = true;
      previous.ws.close(4001, "replaced");
    }

    const client = {
      ws,
      deviceId: message.deviceId,
      crew: uniqueCrewName(crew, message.deviceId),
      role,
      kind: KINDS.includes(message.kind) ? message.kind : "astronaut",
      alive: true,
      addr: ws.addr,
      logTimes: [],
      lastPresence: 0,
    };
    ws.client = client;
    clients.set(client.deviceId, client);
    const known = presence.get(client.deviceId);
    setPresence({
      deviceId: client.deviceId,
      crew: client.crew,
      role: client.role,
      kind: client.kind,
      cell: known?.cell ?? null,
      online: true,
      ts: Date.now(),
      sim: false,
    });
    return send(ws, {
      t: "snapshot",
      seq: doc.seq,
      doc,
      presence: Object.fromEntries(presence),
      hubNow: Date.now(),
      scenario: doc.scenario,
    });
  }

  function isLogRateLimited(client) {
    const now = Date.now();
    client.logTimes = client.logTimes.filter((time) => now - time < LOG_WINDOW_MS);
    if (client.logTimes.length >= options.logPerMin) return true;
    client.logTimes.push(now);
    return false;
  }

  function handleOp(ws, client, message, raw) {
    const cid = message.cid;
    const invalidCid =
      typeof cid !== "string" ||
      cid.length > MAX_CID_LENGTH ||
      !cid.startsWith(`${client.deviceId}:`);
    if (invalidCid || raw.length > MAX_OP_MESSAGE_LENGTH) {
      return send(ws, { t: "nack", cid, reason: "invalid" });
    }
    if (cids.has(cid)) return send(ws, { t: "ack", cid, seq: cids.get(cid) });
    if (message.op?.t === "log.append" && isLogRateLimited(client)) {
      return send(ws, { t: "nack", cid, reason: "limit" });
    }

    let result;
    try {
      result = submitAs(fromOf(client), message.op, cid);
    } catch (e) {
      console.error("hub write error:", e);
      result = { nack: "invalid" };
    }
    if (result.nack) {
      const holder = result.holder ? { holder: result.holder } : {};
      return send(ws, { t: "nack", cid, reason: result.nack, ...holder });
    }
    return send(ws, { t: "ack", cid, seq: result.seq });
  }

  function handlePresence(client, message) {
    const current = presence.get(client.deviceId);
    const now = Date.now();
    if (now - client.lastPresence < PRESENCE_MIN_INTERVAL_MS) return;
    client.lastPresence = now;
    if (!current || !(message.cell === null || isValidCell(message.cell))) return;
    setPresence({
      ...current,
      cell: message.cell,
      kind: KINDS.includes(message.kind) ? message.kind : current.kind,
      online: true,
      ts: Date.now(),
    });
  }

  function onMessage(ws, raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return send(ws, { t: "nack", reason: "invalid" });
    }
    const client = ws.client;
    if (message?.t === "ping") return send(ws, { t: "pong", id: message.id, c: message.c, h: Date.now() });
    if (message?.t === "hello") return handleHello(ws, message);
    if (!client) return send(ws, { t: "nack", reason: "invalid" });
    if (message?.t === "op") return handleOp(ws, client, message, raw);
    if (message?.t === "renew") {
      if (typeof message.target === "string") {
        doc = renew(doc, message.target, fromOf(client), Date.now());
      }
      return;
    }
    if (message?.t === "presence") return handlePresence(client, message);
    return send(ws, { t: "nack", reason: "invalid" });
  }

  const tokenQuery = options.token ? `?token=${encodeURIComponent(options.token)}` : "";
  const lanUrl = (ip = lanIps()[0]) =>
    `http://${ip ?? "localhost"}:${server.address().port}/${tokenQuery}`;

  function joinPage() {
    const ips = lanIps();
    const urls = ips.length ? ips.map((ip) => lanUrl(ip)) : [lanUrl()];
    return joinPageHtml(urls);
  }

  const gzipCache = new Map();
  async function gzipped(filePath, etag) {
    const cached = gzipCache.get(filePath);
    if (cached?.etag === etag) return cached.buf;
    const buf = await new Promise((resolve, reject) => {
      fs.readFile(filePath, (readErr, data) => {
        if (readErr) return reject(readErr);
        zlib.gzip(data, (zipErr, zipped) => (zipErr ? reject(zipErr) : resolve(zipped)));
      });
    });
    gzipCache.set(filePath, { etag, buf });
    return buf;
  }

  function sendFile(req, res, urlPath, filePath, stat) {
    const ext = path.extname(filePath).toLowerCase();
    const etag = makeEtag(stat);
    const headers = {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": cacheControlFor(urlPath, ext),
      ETag: etag,
      "Last-Modified": stat.mtime.toUTCString(),
      Vary: "Accept-Encoding",
      "Server-Timing": "ariadne-hub",
    };
    if (isNotModified(req, etag, stat)) {
      res.writeHead(304, headers).end();
      return;
    }

    const acceptsGzip = /\bgzip\b/.test(req.headers["accept-encoding"] ?? "");
    const useGzip = GZIP.has(ext) && stat.size > 1024 && acceptsGzip;
    if (!useGzip) {
      res.writeHead(200, { ...headers, "Content-Length": stat.size });
      if (req.method === "HEAD") res.end();
      else streamFile(filePath, res);
      return;
    }
    gzipped(filePath, etag).then(
      (buf) => {
        res.writeHead(200, { ...headers, "Content-Encoding": "gzip", "Content-Length": buf.length });
        res.end(req.method === "HEAD" ? undefined : buf);
      },
      () => res.destroy(),
    );
  }

  function serveStatic(req, res) {
    let urlPath;
    try {
      urlPath = decodeURIComponent(req.url.split("?")[0]);
    } catch {
      return badRequest(res);
    }
    if (urlPath.includes("\0")) return badRequest(res);

    let filePath = path.join(WEB, urlPath);
    if (filePath !== WEB && !filePath.startsWith(WEB + path.sep)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    fs.stat(filePath, (err, stat) => {
      if (!err && stat.isDirectory()) filePath = path.join(filePath, "index.html");
      fs.stat(filePath, (fileErr, fileStat) => {
        if (fileErr || !fileStat.isFile()) {
          res.writeHead(404).end("not found");
          return;
        }
        sendFile(req, res, urlPath, filePath, fileStat);
      });
    });
  }

  function sendHealth(res) {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    });
    res.end(
      JSON.stringify({
        ariadne: true,
        version: 2,
        seq: doc.seq,
        clients: clients.size,
        uptimeS: Math.round(process.uptime()),
        sim: scenario?.id ?? null,
      }),
    );
  }

  function sendLog(res) {
    res.writeHead(200, {
      "Content-Type": MIME[".jsonl"],
      "Content-Disposition": 'attachment; filename="ariadne-log.jsonl"',
      "Cache-Control": "no-store",
    });
    if (fs.existsSync(file)) streamFile(file, res);
    else res.end();
  }

  const server = http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end("method not allowed");
      return;
    }
    const url = req.url.split("?")[0];
    if (url === "/health") return sendHealth(res);

    const isJoinRoute = url === "/join" || url === "/qr";
    if (isJoinRoute && options.token && !isLoopback(req.socket.remoteAddress)) {
      res.writeHead(403).end("forbidden: open this page on the hub computer");
      return;
    }
    if (url === "/join") {
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
        .end(joinPage());
      return;
    }
    if (url === "/qr") {
      const svg = qrSvg(lanUrl());
      res
        .writeHead(svg ? 200 : 404, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" })
        .end(svg ?? "");
      return;
    }
    if (url === "/log.jsonl") return sendLog(res);
    serveStatic(req, res);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
  server.on("upgrade", (req, socket, head) => {
    if (req.url.split("?")[0] !== "/sync" || !originOk(req)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.addr = req.socket.remoteAddress;
      wss.emit("connection", ws);
    });
  });
  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      try {
        onMessage(ws, data.toString());
      } catch (e) {
        console.error("hub message error:", e);
      }
    });
    ws.on("pong", () => {
      if (ws.client) ws.client.alive = true;
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      const client = ws.client;
      if (!client || client.replaced) return;
      clients.delete(client.deviceId);
      const entry = presence.get(client.deviceId);
      if (entry) setPresence({ ...entry, online: false, ts: Date.now() });
    });
  });

  function dropStalePresence(now) {
    for (const [id, entry] of presence) {
      if (!entry.online && !entry.sim && now - entry.ts > PRESENCE_EXPIRY_MS) {
        presence.delete(id);
        broadcast({ t: "presence", deviceId: id, online: false, gone: true });
      }
    }
  }

  function pingClients() {
    for (const client of clients.values()) {
      if (!client.alive) {
        client.ws.terminate();
      } else {
        client.alive = false;
        client.ws.ping();
      }
    }
  }

  let ticks = 0;
  const timer = setInterval(() => {
    try {
      const now = Date.now();
      for (const op of sweep(doc, now)) sequence(op, HUB_BY, null);
      simTick();
      dropStalePresence(now);
      ticks += 1;
      if (ticks % HEARTBEAT_EVERY_TICKS === 0) pingClients();
    } catch (e) {
      console.error("hub tick error:", e);
    }
  }, options.tickMs);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });
  const port = server.address().port;

  return {
    port,
    url: `http://localhost:${port}`,
    file,
    lanUrl,
    get doc() {
      return doc;
    },
    get clients() {
      return clients.size;
    },
    presence: () => Object.fromEntries(presence),
    close: () =>
      new Promise((resolve) => {
        clearInterval(timer);
        for (const client of clients.values()) client.ws.terminate();
        wss.close();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
    log,
  };
}

async function printQrCodes(hub, ips) {
  try {
    const qrTerminal = (await import("qrcode-terminal")).default;
    for (const ip of ips) {
      if (ips.length > 1) console.log(`  QR for ${ip}`);
      qrTerminal.generate(hub.lanUrl(ip), { small: true });
    }
  } catch {}
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const port = Number(arg("port", process.env.PORT ?? 8090));
  const host = arg("host", "0.0.0.0");
  const dataDir = path.resolve(arg("data", process.env.HUB_DATA ?? path.join(HERE, "data")));
  const sim = arg("sim", process.env.SIM) || null;
  const token = arg("token", process.env.HUB_TOKEN) || null;

  const hub = await startHub({
    port,
    host,
    dataDir,
    sim: sim && sim !== "none" ? sim : null,
    reset: args.includes("--reset"),
    token,
    quiet: false,
  }).catch((e) => {
    const inUse = `Port ${port} is already in use. Try: node app/hub/server.mjs --port ${port + 1}`;
    console.error(e.code === "EADDRINUSE" ? inUse : e.message);
    process.exit(1);
  });

  const ips = lanIps();
  const simInfo = hub.doc.scenario.running ? ` · sim ${hub.doc.scenario.id}` : "";
  const dataInfo = path.relative(process.cwd(), dataDir) || ".";
  console.log(`\nARIADNE hub · ${hub.doc.seq} ops in log · data ${dataInfo}${simInfo}`);
  console.log(`  This computer   http://localhost:${hub.port}/`);
  for (const ip of ips) console.log(`  On the network  http://${ip}:${hub.port}/`);
  if (!ips.length) {
    console.log("  (no network address found: connect this laptop to the Wi-Fi the phones use)");
  }
  console.log(
    `  Join page + QR  http://localhost:${hub.port}/join   ·   ` +
      `Android app: enter ${ips[0] ?? "<ip>"}:${hub.port}`,
  );
  console.log(
    token
      ? "  Base role needs the join token (it is inside the QR URL; share it only with the base crew)\n"
      : "  No --token: any device on this network can pick the Base role " +
          "(see docs/lan-sync.md, Trust boundary)\n",
  );
  if (ips.length) await printQrCodes(hub, ips);

  const shutdown = async () => {
    await hub.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
