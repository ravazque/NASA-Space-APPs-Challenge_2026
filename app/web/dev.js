import { state, on } from "./store.js";
import { h, esc, toast } from "./ui.js";
import { submit, hubNow } from "./sync.js";
import { clockUtc } from "./marsclock.js";
import { makeEntry, nextId, missionClock, listEntries } from "./log.js";

const WEATHER = {
  caution: { tau: [1.1, 1.1], wind_ms: [13, 13], label: "DEV caution wind" },
  danger: { tau: [2.5, 2.5], wind_ms: [22, 22], label: "DEV dust storm" },
};

const REPORTS = {
  fault3: {
    section: "fault",
    severity: 3,
    at: 0.5,
    radius_m: 60,
    title: "DEV fault sev 3 (blocks)",
    data: { kind: "scarp" },
  },
  hazard2: {
    section: "hazard",
    severity: 2,
    at: 0.3,
    radius_m: 80,
    title: "DEV hazard sev 2 (costly)",
    data: { kind: "loose_sand" },
  },
  env1: {
    section: "env_change",
    severity: 1,
    at: 0.7,
    radius_m: 100,
    title: "DEV dust rising sev 1",
    data: { what: "dust_rise" },
  },
};

const STORM_RADIUS_M = 1500;
const STORM_WIND_DIR_DEG = 250;
const STORM_LENGTH_MS = 1000;
const MINUTE_MS = 60000;
const STORM_ROUTE_POSITION = 0.4;

const me = () => state.ui.me;

function routeCell(fraction) {
  const route = state.plan.route;
  if (!route?.length) return state.data.cheyava;
  return route[Math.floor((route.length - 1) * fraction)];
}

function setWeather(kind) {
  if (kind === "clear") {
    submit({ t: "set", path: "env.override", v: null });
    return;
  }
  const start = state.clock.utcMs ?? clockUtc(state.doc.clock, hubNow());
  submit({
    t: "set",
    path: "env.override",
    v: {
      ...WEATHER[kind],
      wind_dir_deg: STORM_WIND_DIR_DEG,
      t0Utc: start,
      t1Utc: start + STORM_LENGTH_MS,
      cell: routeCell(STORM_ROUTE_POSITION),
      radius_m: STORM_RADIUS_M,
    },
  });
}

function addReport(kind) {
  const { at, ...form } = REPORTS[kind];
  const context = { id: nextId(), me: me(), clock: missionClock() };
  submit({ t: "log.append", entry: makeEntry({ ...form, cell: routeCell(at) }, context) });
}

function resolveAll() {
  const open = listEntries(state.doc).filter(
    ({ e: entry, superseded }) => !superseded && entry.status !== "resolved",
  );
  for (const { e: entry } of open) {
    submit({ t: "log.status", ref: entry.id, status: "resolved" });
  }
  toast(`DEV: resolve sent for ${open.length} entries`);
}

function patchClock(patch) {
  const clock = state.doc.clock;
  const now = hubNow();
  submit({
    t: "set",
    path: "clock",
    v: { ...clock, anchorUtcMs: clockUtc(clock, now), anchorWallMs: now, ...patch },
  });
}

function jumpMinutes(minutes) {
  const clock = state.doc.clock;
  const now = hubNow();
  const anchorUtcMs = clockUtc(clock, now) + minutes * MINUTE_MS;
  submit({ t: "set", path: "clock", v: { ...clock, anchorUtcMs, anchorWallMs: now } });
}

const ACTIONS = [
  ["Weather", true, [
    ["Clear", () => setWeather("clear")],
    ["Caution", () => setWeather("caution")],
    ["Danger", () => setWeather("danger")],
  ]],
  ["Report on route", false, [
    ["Fault 3", () => addReport("fault3")],
    ["Hazard 2", () => addReport("hazard2")],
    ["Dust 1", () => addReport("env1")],
    ["Resolve all", resolveAll],
  ]],
  ["Clock", true, [
    ["+30 min", () => jumpMinutes(30)],
    ["x600", () => patchClock({ rate: 600 })],
    ["x60", () => patchClock({ rate: 60 })],
    ["Pause / play", () => patchClock({ paused: !state.doc.clock.paused })],
  ]],
];

function buildRow(label, isWorld, buttons) {
  const row = h("div", "dev-row", `<span>${esc(label)}</span>`);
  for (const [text, onClick] of buttons) {
    const button = h("button", null, esc(text));
    button.type = "button";
    button.dataset.world = isWorld ? "1" : "";
    button.addEventListener("click", onClick);
    row.append(button);
  }
  return row;
}

export function init() {
  if (!new URLSearchParams(location.search).has("dev")) return;

  const box = h("details", "dev-panel");
  box.innerHTML = `<summary>DEV <span class="dev-who">${esc(me().crew)} · ${esc(me().role)}`
    + `</span></summary>`;
  for (const [label, isWorld, buttons] of ACTIONS) {
    box.append(buildRow(label, isWorld, buttons));
  }
  const note = h("p", "dev-note",
    "Weather and clock need <b>?role=base</b> on a hub; crew can only resolve its own entries.");
  box.append(note);
  document.body.append(box);

  const gate = () => {
    const allowed = state.net.status === "solo" || me().role === "base";
    for (const button of box.querySelectorAll("[data-world='1']")) {
      button.disabled = !allowed;
    }
    note.hidden = allowed;
  };
  on("net", gate);
  on("ui", gate);
  gate();
}
