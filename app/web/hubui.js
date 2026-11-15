import { state, set, on } from "./store.js";
import { t, apply } from "./i18n.js";
import { $, esc, tag } from "./ui.js";
import { connect, disconnect, identify, hubNow } from "./sync.js";

const GLYPH = { synced: "●", connecting: "◐", offline: "○", solo: "" };
const KIND_ICON = { astronaut: "A", vehicle: "V", base: "B" };
let map = null, dlg = null;

const msText = (ms) => (ms == null ? "" : t("hub.chip.ms", { ms: ms < 1 ? "<1" : ms < 10 ? ms.toFixed(1) : Math.round(ms) }));
function renderChip() {
  const n = state.net, s = n.status, slow = n.rttMs != null && n.rttMs >= 150;
  const pend = n.pending ? ` · ${t("hub.chip.pending", { n: n.pending })}` : "";
  let word, more = "", ms = "";
  if (s === "synced") { word = t("hub.chip.synced"); more = ` · ${t("hub.chip.crew", { n: n.peers })}`; ms = msText(n.rttMs); }
  else if (s === "connecting") { word = t("hub.chip.connecting"); more = pend; }
  else if (s === "offline") { word = t("hub.chip.offline"); more = pend; }
  else { word = t("hub.chip.solo"); more = ` · ${t("hub.chip.connect")}`; }
  let b = $("sync-chip").firstElementChild;
  if (!b) {
    $("sync-chip").innerHTML = `<button type="button" class="chip" aria-haspopup="dialog"><span class="glyph" aria-hidden="true"></span><span class="word"></span><span class="more"></span><span class="msw"> · <span class="ms"></span></span></button>`;
    b = $("sync-chip").firstElementChild;
  }
  const q = (c) => b.querySelector(c), glyph = q(".glyph"), msw = q(".msw"), msEl = q(".ms");
  const cls = `chip chip-${s}`;
  if (b.className !== cls) b.className = cls;
  const setText = (el, v) => { if (el.textContent !== v) el.textContent = v; };
  const title = t("hub.chip.title");
  if (b.title !== title) b.title = title;
  glyph.hidden = !GLYPH[s]; setText(glyph, GLYPH[s]);
  setText(q(".word"), word); setText(q(".more"), more);
  msw.hidden = s !== "synced"; setText(msEl, ms);
  msEl.classList.toggle("slow", slow);
}

const dialogHtml = () => `<form method="dialog" class="hub-form" aria-labelledby="hub-t">
  <h2 id="hub-t" data-i18n="hub.dlg.title">Field network</h2>
  <p id="hub-status" class="hub-status" role="status"></p>
  <fieldset><legend data-i18n="hub.dlg.you">You</legend>
    <label><span data-i18n="hub.dlg.callsign">Callsign</span><input id="hub-crew" maxlength="12" autocomplete="off" autocapitalize="characters" spellcheck="false"></label>
    <label><span data-i18n="hub.dlg.role">Role</span><select id="hub-role"><option value="crew" data-i18n="hub.dlg.role.crew">Crew (EVA)</option><option value="base" data-i18n="hub.dlg.role.base">Base (habitat)</option></select></label>
    <p class="hint" data-i18n="hub.dlg.role_note"></p>
    <label><span data-i18n="hub.dlg.kind">Type</span><select id="hub-kind"><option value="astronaut" data-i18n="hub.dlg.kind.astronaut">Astronaut</option><option value="vehicle" data-i18n="hub.dlg.kind.vehicle">Vehicle</option><option value="base" data-i18n="hub.dlg.kind.base">Base</option></select></label>
    <div><span class="lbl" data-i18n="hub.dlg.pos">Position</span> · <span id="hub-pos"></span></div>
    <div class="row"><button type="button" class="btn" id="hub-here" data-i18n="hub.dlg.pos.set">Set my position on the map</button><button type="button" class="btn" id="hub-auto" data-i18n="hub.dlg.pos.auto">Use route position</button></div>
  </fieldset>
  <fieldset><legend data-i18n="hub.dlg.hub">Hub</legend>
    <label><span data-i18n="hub.dlg.addr">Hub address</span><input id="hub-addr" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="192.168.1.20:8090"></label>
    <p class="hint" data-i18n="hub.dlg.addr_hint"></p><p id="hub-err" class="err" role="alert" hidden data-i18n="hub.dlg.bad_addr"></p>
    <div class="row"><button type="button" class="btn primary" id="hub-connect" data-i18n="hub.dlg.connect">Connect</button><button type="button" class="btn" id="hub-solo" data-i18n="hub.dlg.solo">Work solo</button>
      <a id="hub-join" target="_blank" rel="noopener" data-i18n="hub.dlg.join" hidden>Open the hub's join page</a></div>
  </fieldset>
  <section><h3 data-i18n="hub.dlg.peers">Crew on the network</h3><ul id="hub-peers" class="hub-peers"></ul></section>
  <div class="row"><button class="btn" value="close" data-i18n="hub.dlg.close">Close</button></div>
</form>`;

const minutesAgo = (p) => Math.max(1, Math.floor((hubNow() - (p.ts ?? hubNow())) / 60000));
const staleOf = (p) => !p.online || state.net.status === "connecting" || state.net.status === "offline";

function renderDialog() {
  if (!dlg?.open) return;
  const n = state.net, hub = n.hub ?? "";
  const st = $("hub-status");
  st.dataset.state = n.status;
  st.textContent = n.status === "solo" ? t("hub.status.solo")
    : n.status === "connecting" ? t("hub.status.connecting", { hub })
    : n.status === "offline" ? t("hub.status.offline", { hub, n: n.pending })
    : n.rttMs == null ? t("hub.status.synced_nopings", { hub, n: n.peers })
    : t("hub.status.synced", { hub, n: n.peers, ms: n.rttMs < 10 ? n.rttMs.toFixed(1) : Math.round(n.rttMs), off: `${n.offsetMs >= 0 ? "+" : "−"}${Math.abs(n.offsetMs)}` });
  $("hub-pos").textContent = t(state.ui.me.manualCell != null ? "hub.dlg.pos.manual" : "hub.dlg.pos.route");
  $("hub-auto").disabled = state.ui.me.manualCell == null;
  const join = $("hub-join");
  join.hidden = !hub; if (hub) join.href = `http://${hub}/join`;
  const mine = state.ui.me.deviceId, list = Object.values(state.presence).sort((a, b) => b.online - a.online || String(a.crew).localeCompare(b.crew));
  $("hub-peers").innerHTML = list.length ? list.map((p) => {
    const off = staleOf(p), you = p.deviceId === mine;
    return `<li><span aria-hidden="true">${KIND_ICON[p.kind] ?? "?"}</span><span class="who">${esc(p.crew)}${you ? ` (${esc(t("hub.dlg.you_tag"))})` : ""} ${p.sim ? tag("SIMULATED") : ""}</span>`
      + `<span class="${off ? "off" : ""}">${esc(off ? t("hub.los", { n: minutesAgo(p) }) : t("hub.online"))}</span></li>`;
  }).join("") : `<li><span class="none">${esc(t("hub.dlg.none"))}</span></li>`;
}

function openDialog() {
  const me = state.ui.me;
  $("hub-crew").value = me.crew; $("hub-role").value = me.role; $("hub-kind").value = me.kind ?? "astronaut";
  $("hub-addr").value = state.net.hub ?? (() => { try { return localStorage.getItem("ariadne.hub") ?? ""; } catch { return ""; } })();
  $("hub-err").hidden = true;
  dlg.showModal();
  renderDialog();
  $("hub-crew").focus();
}

function onConnect() {
  let addr = $("hub-addr").value.trim().replace(/^(https?|wss?):\/\//i, "").replace(/\/.*$/, "");
  if (addr && !/^[\w.-]+(:\d{1,5})?$/.test(addr)) { $("hub-err").hidden = false; $("hub-addr").focus(); return; }
  $("hub-err").hidden = true;
  const role = $("hub-role").value;
  identify({ crew: $("hub-crew").value, role, kind: role === "base" && $("hub-kind").value === "astronaut" ? "base" : $("hub-kind").value });
  if (addr) { if (!addr.includes(":")) addr += ":8090"; connect(addr); }
  renderDialog();
}

async function pickMyCell() {
  dlg.close();
  const cell = await map?.pickCell?.("hub.pick.me");
  if (Number.isInteger(cell)) set("ui", { me: { ...state.ui.me, manualCell: cell } });
}

let queued = 0;
const schedule = () => { queued ||= requestAnimationFrame(() => { queued = 0; drawMap(); }); };
function drawMap() {
  if (!map?.markers) return;
  const mine = state.ui.me.deviceId;
  const crew = Object.values(state.presence).filter((p) => p.deviceId !== mine && Number.isInteger(p.cell)).map((p) => {
    const stale = staleOf(p);
    return { id: `crew:${p.deviceId}`, cell: p.cell, kind: p.kind === "vehicle" ? "vehicle" : p.kind === "base" ? "base" : "astronaut", label: p.crew,
      sub: stale ? t("hub.los", { n: minutesAgo(p) }) : p.sim ? t("hub.sim") : undefined, stale };
  });
  map.markers("hub:crew", crew.length ? crew : null);
  const doc = state.doc;
  const assets = Object.values(doc.assets ?? {}).filter((a) => Number.isInteger(a.cell)).map((a) => {
    const lock = doc.locks?.[`equip:${a.id}`];
    return { id: `asset:${a.id}`, cell: a.cell, kind: a.kind, label: a.name, sub: lock ? t("hub.inuse", { crew: lock.holder.crew }) : undefined, provisional: !!lock?.provisional };
  });
  map.markers("hub:assets", assets.length ? assets : null);
}

export async function init(ctx) {
  map = ctx.map;
  dlg = $("hub-dialog");
  dlg.innerHTML = dialogHtml();
  apply(dlg);
  $("sync-chip").addEventListener("click", (e) => { if (e.target.closest(".chip")) openDialog(); });
  $("hub-connect").addEventListener("click", onConnect);
  $("hub-solo").addEventListener("click", () => { disconnect(); $("hub-addr").value = ""; renderDialog(); });
  $("hub-here").addEventListener("click", pickMyCell);
  $("hub-auto").addEventListener("click", () => { const { manualCell, ...me } = state.ui.me; set("ui", { me }); renderDialog(); });
  for (const id of ["hub-addr", "hub-crew"]) $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); onConnect(); } });
  renderChip();
  let lastAssets = state.doc.assets, lastLocks = state.doc.locks;
  on("map:here", (cell) => Number.isInteger(cell) && set("ui", { me: { ...state.ui.me, manualCell: cell } }));
  on("net", () => { renderChip(); renderDialog(); schedule(); });
  on("presence", () => { renderDialog(); schedule(); });
  on("doc", (d) => { if (d.assets !== lastAssets || d.locks !== lastLocks) { lastAssets = d.assets; lastLocks = d.locks; schedule(); } });
  on("ui", () => renderDialog());
  on("lang", () => { renderChip(); apply(dlg); renderDialog(); schedule(); });
  setInterval(() => { if (state.net.status !== "synced") { renderDialog(); schedule(); } }, 15000);
  schedule();
}
