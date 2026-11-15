import { state, set, on } from "./store.js";
import { t, apply, shown } from "./i18n.js";
import { $, esc, tag, ico } from "./ui.js";
import { connect, disconnect, identify, hubNow } from "./sync.js";

const GLYPH = { synced: "g-dot-on", connecting: "g-dot-half", offline: "g-dot-off", solo: "" };
const KIND_ICON = { astronaut: "A", vehicle: "V", base: "B" };
const SLOW_RTT_MS = 150;
const REDRAW_MS = 15000;
const DEFAULT_HUB_PORT = 8090;
const ADDRESS_RE = /^[\w.-]+(:\d{1,5})?$/;

let map = null;
let dlg = null;

function msText(ms) {
  if (ms == null) return "";
  const shownMs = ms < 1 ? "<1" : ms < 10 ? ms.toFixed(1) : Math.round(ms);
  return t("hub.chip.ms", { ms: shownMs });
}

function chipParts(net) {
  const pending = net.pending ? ` · ${t("hub.chip.pending", { n: net.pending })}` : "";
  if (net.status === "synced") {
    return {
      word: t("hub.chip.synced"),
      more: ` · ${t("hub.chip.crew", { n: net.peers })}`,
      ms: msText(net.rttMs),
    };
  }
  if (net.status === "connecting") return { word: t("hub.chip.connecting"), more: pending, ms: "" };
  if (net.status === "offline") return { word: t("hub.chip.offline"), more: pending, ms: "" };
  return { word: t("hub.chip.solo"), more: ` · ${t("hub.chip.connect")}`, ms: "" };
}

function setText(el, value) {
  if (el.textContent !== value) el.textContent = value;
}

function chipButton() {
  const container = $("sync-chip");
  if (!container.firstElementChild) {
    container.innerHTML =
      `<button type="button" class="chip" aria-haspopup="dialog">` +
      `<span class="glyph" aria-hidden="true"></span>` +
      `<span class="word"></span>` +
      `<span class="more"></span>` +
      `<span class="msw"> · <span class="ms"></span></span>` +
      `</button>`;
  }
  return container.firstElementChild;
}

function renderChip() {
  const net = state.net;
  const status = net.status;
  const slow = net.rttMs != null && net.rttMs >= SLOW_RTT_MS;
  const { word, more, ms } = chipParts(net);

  const button = chipButton();
  const glyph = button.querySelector(".glyph");
  const msWrap = button.querySelector(".msw");
  const msEl = button.querySelector(".ms");

  const className = `chip chip-${status}`;
  if (button.className !== className) button.className = className;

  const title = t("hub.chip.title");
  if (button.title !== title) button.title = title;

  glyph.hidden = !GLYPH[status];
  if (glyph.dataset.s !== status) {
    glyph.dataset.s = status;
    glyph.innerHTML = GLYPH[status] ? ico(GLYPH[status]) : "";
  }

  setText(button.querySelector(".word"), word);
  setText(button.querySelector(".more"), more);
  msWrap.hidden = status !== "synced";
  setText(msEl, ms);
  msEl.classList.toggle("slow", slow);
}

const dialogHtml = () => `<form method="dialog" class="hub-form" aria-labelledby="hub-t">
  <h2 id="hub-t" data-i18n="hub.dlg.title">Field network</h2>
  <p id="hub-status" class="hub-status" role="status"></p>
  <fieldset><legend data-i18n="hub.dlg.you">You</legend>
    <label><span data-i18n="hub.dlg.callsign">Callsign</span><input
      id="hub-crew" maxlength="12" autocomplete="off"
      autocapitalize="characters" spellcheck="false"></label>
    <label><span data-i18n="hub.dlg.role">Role</span><select id="hub-role">
      <option value="crew" data-i18n="hub.dlg.role.crew">Crew (EVA)</option>
      <option value="base" data-i18n="hub.dlg.role.base">Base (habitat)</option>
    </select></label>
    <p class="hint" data-i18n="hub.dlg.role_note"></p>
    <label><span data-i18n="hub.dlg.kind">Type</span><select id="hub-kind">
      <option value="astronaut" data-i18n="hub.dlg.kind.astronaut">Astronaut</option>
      <option value="vehicle" data-i18n="hub.dlg.kind.vehicle">Vehicle</option>
      <option value="base" data-i18n="hub.dlg.kind.base">Base</option>
    </select></label>
    <div>
      <span class="lbl" data-i18n="hub.dlg.pos">Position</span> ·
      <span id="hub-pos"></span>
    </div>
    <div class="row"><button
      type="button" class="btn" id="hub-here"
      data-i18n="hub.dlg.pos.set">Set my position on the map</button><button
      type="button" class="btn" id="hub-auto"
      data-i18n="hub.dlg.pos.auto">Use route position</button></div>
  </fieldset>
  <fieldset><legend data-i18n="hub.dlg.hub">Hub</legend>
    <label><span data-i18n="hub.dlg.addr">Hub address</span><input
      id="hub-addr" inputmode="url" autocomplete="off" autocapitalize="off"
      spellcheck="false" placeholder="192.168.1.20:8090"></label>
    <p class="hint" data-i18n="hub.dlg.addr_hint"></p><p
      id="hub-err" class="err" role="alert" hidden data-i18n="hub.dlg.bad_addr"></p>
    <div class="row"><button
      type="button" class="btn primary" id="hub-connect"
      data-i18n="hub.dlg.connect">Connect</button><button
      type="button" class="btn" id="hub-solo"
      data-i18n="hub.dlg.solo">Work solo</button>
      <a id="hub-join" target="_blank" rel="noopener"
        data-i18n="hub.dlg.join" hidden>Open the hub's join page</a></div>
  </fieldset>
  <section>
    <h3 data-i18n="hub.dlg.peers">Crew on the network</h3>
    <ul id="hub-peers" class="hub-peers"></ul>
  </section>
  <div class="row"><button class="btn" value="close" data-i18n="hub.dlg.close">Close</button></div>
</form>`;

function minutesAgo(peer) {
  return Math.max(1, Math.floor((hubNow() - (peer.ts ?? hubNow())) / 60000));
}

function isStale(peer) {
  const disconnected = state.net.status === "connecting" || state.net.status === "offline";
  return !peer.online || disconnected;
}

function statusText(net) {
  const hub = net.hub ?? "";
  if (net.status === "solo") return t("hub.status.solo");
  if (net.status === "connecting") return t("hub.status.connecting", { hub });
  if (net.status === "offline") return t("hub.status.offline", { hub, n: net.pending });
  if (net.rttMs == null) return t("hub.status.synced_nopings", { hub, n: net.peers });
  const ms = net.rttMs < 10 ? net.rttMs.toFixed(1) : Math.round(net.rttMs);
  const sign = net.offsetMs >= 0 ? "+" : "−";
  const off = `${sign}${Math.abs(net.offsetMs)}`;
  return t("hub.status.synced", { hub, n: net.peers, ms, off });
}

function peerRowHtml(peer, myDeviceId) {
  const stale = isStale(peer);
  const isMe = peer.deviceId === myDeviceId;
  const youTag = isMe ? ` (${esc(t("hub.dlg.you_tag"))})` : "";
  const simTag = peer.sim ? tag("SIMULATED") : "";
  const presence = stale ? t("hub.los", { n: minutesAgo(peer) }) : t("hub.online");
  return (
    `<li><span aria-hidden="true">${KIND_ICON[peer.kind] ?? "?"}</span>` +
    `<span class="who">${esc(peer.crew)}${youTag} ${simTag}</span>` +
    `<span class="${stale ? "off" : ""}">${esc(presence)}</span></li>`
  );
}

function sortPeers(a, b) {
  return b.online - a.online || String(a.crew).localeCompare(b.crew);
}

function renderDialog() {
  if (!dlg?.open) return;
  const net = state.net;
  const hub = net.hub ?? "";
  const manual = state.ui.me.manualCell != null;

  const status = $("hub-status");
  status.dataset.state = net.status;
  status.textContent = statusText(net);

  $("hub-pos").textContent = t(manual ? "hub.dlg.pos.manual" : "hub.dlg.pos.route");
  $("hub-auto").disabled = !manual;

  const join = $("hub-join");
  join.hidden = !hub;
  if (hub) join.href = `http://${hub}/join`;

  const peers = Object.values(state.presence).sort(sortPeers);
  const myDeviceId = state.ui.me.deviceId;
  $("hub-peers").innerHTML = peers.length
    ? peers.map((peer) => peerRowHtml(peer, myDeviceId)).join("")
    : `<li><span class="none">${esc(t("hub.dlg.none"))}</span></li>`;
}

function savedHub() {
  try {
    return localStorage.getItem("ariadne.hub") ?? "";
  } catch {
    return "";
  }
}

function openDialog() {
  const me = state.ui.me;
  $("hub-crew").value = me.crew;
  $("hub-role").value = me.role;
  $("hub-kind").value = me.kind ?? "astronaut";
  $("hub-addr").value = state.net.hub ?? savedHub();
  $("hub-err").hidden = true;
  dlg.showModal();
  renderDialog();
  $("hub-crew").focus();
}

function onConnect() {
  let addr = $("hub-addr").value.trim().replace(/^(https?|wss?):\/\//i, "").replace(/\/.*$/, "");
  if (addr && !ADDRESS_RE.test(addr)) {
    $("hub-err").hidden = false;
    $("hub-addr").focus();
    return;
  }
  $("hub-err").hidden = true;

  const role = $("hub-role").value;
  const selectedKind = $("hub-kind").value;
  const kind = role === "base" && selectedKind === "astronaut" ? "base" : selectedKind;
  identify({ crew: $("hub-crew").value, role, kind });

  if (addr) {
    if (!addr.includes(":")) addr += `:${DEFAULT_HUB_PORT}`;
    connect(addr);
  }
  renderDialog();
}

async function pickMyCell() {
  dlg.close();
  const cell = await map?.pickCell?.("hub.pick.me");
  if (Number.isInteger(cell)) set("ui", { me: { ...state.ui.me, manualCell: cell } });
}

let redrawQueued = false;

function schedule() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => {
    redrawQueued = false;
    drawMap();
  });
}

function markerKind(kind) {
  if (kind === "vehicle" || kind === "base") return kind;
  return "astronaut";
}

function crewMarkers() {
  const myDeviceId = state.ui.me.deviceId;
  return Object.values(state.presence)
    .filter((p) => p.deviceId !== myDeviceId && Number.isInteger(p.cell))
    .map((p) => {
      const stale = isStale(p);
      let sub;
      if (stale) sub = t("hub.los", { n: minutesAgo(p) });
      else if (p.sim) sub = t("hub.sim");
      return {
        id: `crew:${p.deviceId}`,
        cell: p.cell,
        kind: markerKind(p.kind),
        label: p.crew,
        sub,
        stale,
      };
    });
}

function assetMarkers() {
  const doc = state.doc;
  return Object.values(doc.assets ?? {})
    .filter((a) => Number.isInteger(a.cell))
    .map((a) => {
      const lock = doc.locks?.[`equip:${a.id}`];
      return {
        id: `asset:${a.id}`,
        cell: a.cell,
        kind: a.kind,
        label: shown(a.name),
        sub: lock ? t("hub.inuse", { crew: lock.holder.crew }) : undefined,
        provisional: !!lock?.provisional,
      };
    });
}

function drawMap() {
  if (!map?.markers) return;
  const crew = crewMarkers();
  map.markers("hub:crew", crew.length ? crew : null);
  const assets = assetMarkers();
  map.markers("hub:assets", assets.length ? assets : null);
}

function setManualCell(cell) {
  set("ui", { me: { ...state.ui.me, manualCell: cell } });
}

function useRoutePosition() {
  const { manualCell, ...me } = state.ui.me;
  set("ui", { me });
  renderDialog();
}

function workSolo() {
  disconnect();
  $("hub-addr").value = "";
  renderDialog();
}

export async function init(ctx) {
  map = ctx.map;
  dlg = $("hub-dialog");
  dlg.innerHTML = dialogHtml();
  apply(dlg);

  $("sync-chip").addEventListener("click", (e) => {
    if (e.target.closest(".chip")) openDialog();
  });
  $("hub-connect").addEventListener("click", onConnect);
  $("hub-solo").addEventListener("click", workSolo);
  $("hub-here").addEventListener("click", pickMyCell);
  $("hub-auto").addEventListener("click", useRoutePosition);
  for (const id of ["hub-addr", "hub-crew"]) {
    $(id).addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      onConnect();
    });
  }

  renderChip();

  let lastAssets = state.doc.assets;
  let lastLocks = state.doc.locks;
  on("map:here", (cell) => Number.isInteger(cell) && setManualCell(cell));
  on("net", () => {
    renderChip();
    renderDialog();
    schedule();
  });
  on("presence", () => {
    renderDialog();
    schedule();
  });
  on("doc", (doc) => {
    if (doc.assets === lastAssets && doc.locks === lastLocks) return;
    lastAssets = doc.assets;
    lastLocks = doc.locks;
    schedule();
  });
  on("ui", () => renderDialog());
  on("lang", () => {
    renderChip();
    apply(dlg);
    renderDialog();
    schedule();
  });

  setInterval(() => {
    if (state.net.status === "synced") return;
    renderDialog();
    schedule();
  }, REDRAW_MS);
  schedule();
}
