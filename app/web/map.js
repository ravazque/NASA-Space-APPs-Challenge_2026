import { state, set, on, emit } from "./store.js";
import { t, num } from "./i18n.js";
import { $, esc, ico, toast } from "./ui.js";
import { setGoal } from "./plan.js";
import { setGrid, cellToLatLng, latLngToCell, bounds, maskSegments, metersPerPx } from "./geo.js";

const L = window.L;
const METERS_PER_DEGREE = (Math.PI * 3396190) / 180;
const css = getComputedStyle(document.documentElement);
const BLANK_TILE = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const ATTRIBUTION = "HiRISE: NASA/JPL/University of Arizona, via NASA Mars Trek";
const TILE_DEG = 180 / 2 ** 13;
const TILE_MARGIN_DEG = 0.005;
const RING_POINTS = 64;

const PANES = {
  base: 200,
  raster: 250,
  graticule: 260,
  wash: 300,
  pattern: 350,
  outline: 400,
  lines: 450,
  markers: 600,
  plates: 650,
};

let map;
let host;
let rows;
let cols;
let data;
let gridBounds;
let tileBounds;
const items = new Map();
const hidden = new Set();
let legacyOff = false;
let picker = null;
let lastUi = {};
let declutterFrame;
let pickBox;
let scrollBeforePick = null;
let scaleEl;
let readoutEl;
let graticuleEl;
let noteEl;
let isHovering = false;
let envelopePolys = [];
let lastPlan = {};

const resolveColor = (name) => {
  const isToken = typeof name === "string" && name.startsWith("--");
  return isToken ? css.getPropertyValue(name).trim() : name;
};

function sameArray(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, i) => value === b[i]);
}

const scratch = document.createElement("canvas");
scratch.width = 1;
scratch.height = 1;

function rgba(color) {
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = resolveColor(color);
  ctx.fillRect(0, 0, 1, 1);
  return [...ctx.getImageData(0, 0, 1, 1).data];
}

function pixelsToUrl(pixels) {
  const canvas = document.createElement("canvas");
  canvas.width = cols;
  canvas.height = rows;
  canvas.getContext("2d").putImageData(new ImageData(pixels, cols, rows), 0, 0);
  return canvas.toDataURL("image/png");
}

function put(id, layer, extra) {
  if (id.startsWith("layers:")) killLegacy();
  const old = items.get(id);
  if (old && old.layer !== layer) map.removeLayer(old.layer);
  if (!layer) {
    items.delete(id);
    return;
  }
  items.set(id, { layer, ...extra });
  if (!hidden.has(id)) layer.addTo(map);
}

function image(id, pixels, pane, opacity = 1) {
  if (!pixels) return put(id, null);
  const url = pixelsToUrl(pixels);
  const existing = items.get(id);
  if (existing?.layer.setUrl) {
    existing.layer.setUrl(url);
    existing.layer.setOpacity(opacity);
    return;
  }
  put(id, L.imageOverlay(url, gridBounds, {
    pane,
    opacity,
    className: "px",
    interactive: false,
    zIndex: 1,
  }));
}

function chain(segments) {
  const key = (point) => `${point[0]},${point[1]}`;
  const segmentsAt = new Map();
  const used = new Uint8Array(segments.length);
  const lines = [];

  segments.forEach((segment, i) => {
    for (const point of segment) {
      const k = key(point);
      if (!segmentsAt.has(k)) segmentsAt.set(k, []);
      segmentsAt.get(k).push(i);
    }
  });

  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const line = [...segments[i]];

    // Walk forward from the last point, then reverse and walk the other end
    for (let pass = 0; pass < 2; pass++) {
      for (;;) {
        const end = line[line.length - 1];
        const next = segmentsAt.get(key(end)).find((n) => !used[n]);
        if (next == null) break;
        used[next] = 1;
        const [first, second] = segments[next];
        line.push(key(first) === key(end) ? second : first);
      }
      line.reverse();
    }
    lines.push(line);
  }
  return lines;
}

function strokes(id, polylines, pane, options = {}) {
  const {
    token = "--ink",
    width = 2,
    halo = false,
    dash = null,
    opacity = 1,
    cap = "round",
    join = "round",
  } = options;

  if (!polylines?.length) return put(id, null);

  const group = L.layerGroup();
  const base = { pane, interactive: false, lineCap: cap, lineJoin: join, fill: false };
  if (halo) {
    group.addLayer(L.polyline(polylines, {
      ...base,
      color: resolveColor(halo === true ? "--ground" : halo),
      weight: width + 3,
      opacity: 1,
    }));
  }
  group.addLayer(L.polyline(polylines, {
    ...base,
    color: resolveColor(token),
    weight: width,
    opacity,
    dashArray: Array.isArray(dash) ? dash.join(" ") : dash,
  }));
  put(id, group);
}

const PATTERN_KINDS = {
  "hatch-red": { lines: [6, "/"], w: 2, color: "--red", base: "--wash-forbid" },
  "hatch-ink": { lines: [6, "\\"], w: 1, color: "--ink", a: 0.55 },
  "dots-ink": { dots: [6, 1], color: "--ink", a: 0.55 },
};

const patternCache = new Map();

function patternSpec(kind) {
  if (typeof kind !== "string") return kind;
  return PATTERN_KINDS[kind] ?? PATTERN_KINDS["hatch-ink"];
}

function drawHatch(ctx, direction, size) {
  const offsets = [-size, 0, size];
  if (direction === "h" || direction === "x") {
    ctx.moveTo(0, size / 2);
    ctx.lineTo(size, size / 2);
  }
  if (direction === "v" || direction === "x") {
    ctx.moveTo(size / 2, 0);
    ctx.lineTo(size / 2, size);
  }
  if (direction === "\\") {
    for (const offset of offsets) {
      ctx.moveTo(offset, 0);
      ctx.lineTo(offset + size, size);
    }
  }
  if (direction === "/") {
    for (const offset of offsets) {
      ctx.moveTo(offset, size);
      ctx.lineTo(offset + size, 0);
    }
  }
}

function patternFor(kind, scale) {
  const spec = patternSpec(kind);
  const color = resolveColor(spec.color ?? "--ink");
  const cacheKey = JSON.stringify([spec, scale, color]);
  if (patternCache.has(cacheKey)) return patternCache.get(cacheKey);

  const size = (spec.dots ?? spec.lines)[0];
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = Math.round(size * scale);
  canvas.height = canvas.width;
  ctx.scale(scale, scale);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.globalAlpha = spec.a ?? 1;
  ctx.lineWidth = spec.w ?? 1;
  ctx.lineCap = "butt";
  ctx.beginPath();
  if (spec.dots) {
    ctx.arc(size / 2, size / 2, spec.dots[1], 0, 2 * Math.PI);
    ctx.fill();
  } else {
    drawHatch(ctx, spec.lines[1], size);
    ctx.stroke();
  }

  const pattern = ctx.createPattern(canvas, "repeat");
  pattern.setTransform?.(new DOMMatrix().scale(1 / scale));
  patternCache.set(cacheKey, pattern);
  return pattern;
}

const PatternLayer = L.GridLayer.extend({
  createTile(coords) {
    const leaflet = this._map;
    const zoom = coords.z;
    const ratio = Math.min(2, devicePixelRatio || 1);
    const size = this.getTileSize().x;
    const tile = document.createElement("canvas");
    const ctx = tile.getContext("2d");
    tile.width = size * ratio;
    tile.height = size * ratio;

    const tileOrigin = coords.scaleBy(this.getTileSize());
    const gridNW = leaflet.project([gridBounds[1][0], gridBounds[0][1]], zoom);
    const gridSE = leaflet.project([gridBounds[0][0], gridBounds[1][1]], zoom);
    const cellW = (gridSE.x - gridNW.x) / cols;
    const cellH = (gridSE.y - gridNW.y) / rows;
    const colMin = Math.max(0, Math.floor((tileOrigin.x - gridNW.x) / cellW));
    const colMax = Math.min(cols - 1, Math.ceil((tileOrigin.x + size - gridNW.x) / cellW));
    const rowMin = Math.max(0, Math.floor((tileOrigin.y - gridNW.y) / cellH));
    const rowMax = Math.min(rows - 1, Math.ceil((tileOrigin.y + size - gridNW.y) / cellH));

    const path = new Path2D();
    const mask = this.mask;
    for (let row = rowMin; row <= rowMax; row++) {
      let col = colMin;
      while (col <= colMax) {
        if (!mask[row * cols + col]) {
          col++;
          continue;
        }
        let runEnd = col;
        while (runEnd + 1 <= colMax && mask[row * cols + runEnd + 1]) runEnd++;
        const x = gridNW.x + col * cellW;
        const y = gridNW.y + row * cellH;
        path.rect(x, y, (runEnd - col + 1) * cellW, cellH);
        col = runEnd + 1;
      }
    }

    ctx.scale(ratio, ratio);
    ctx.translate(-tileOrigin.x, -tileOrigin.y);
    const spec = typeof this.kind === "string" ? PATTERN_KINDS[this.kind] : this.kind;
    if (spec?.base) {
      ctx.fillStyle = resolveColor(spec.base);
      ctx.fill(path);
    }
    ctx.fillStyle = patternFor(this.kind, ratio);
    ctx.fill(path);
    return tile;
  },
});

const svgSymbol = (...parts) => (
  `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${parts.join("")}</svg>`
);
const HALO = 'fill="var(--ground)" stroke="var(--ground)" stroke-width="2"';
const FILL_INK = 'fill="var(--ink)"';
const FILL_SURFACE = 'fill="var(--surface)"';
const INK_OUTLINE = 'stroke="var(--ink)" stroke-width="2"';

const housePath = (fill) => `<path d="M5 12L12 5.5L19 12V19H14V14H10V19H5Z" fill="${fill}"/>`;
const signSymbol = (id) => (
  `<rect x="1" y="1" width="22" height="22" ${HALO}/>`
  + `<use href="#${id}" x="2.5" y="2.5" width="19" height="19"/>`
);
const warningTriangle = (inner) => (
  '<path d="M12 2.5L23 21.5H1Z" fill="var(--yellow)" stroke="var(--ink)"'
  + ` stroke-width="2" stroke-linejoin="round"/>${inner}`
);

const ZIGZAG = "M2.5 18.5L8.5 8L13 14.5L21.5 4.5";

const SYMBOLS = {
  start: svgSymbol(
    `<rect x="2" y="2" width="20" height="20" ${HALO}/>`,
    `<rect x="4" y="4" width="16" height="16" ${FILL_INK}/>`,
    '<rect x="9.5" y="9.5" width="5" height="5" fill="var(--ground)"/>',
  ),
  dest: svgSymbol(
    `<circle cx="12" cy="12" r="10.5" ${HALO}/>`,
    '<circle cx="12" cy="12" r="8.5" fill="var(--blue)"/>',
    `<circle cx="12" cy="12" r="2.4" ${FILL_SURFACE}/>`,
  ),
  me: svgSymbol(
    `<circle cx="12" cy="12" r="10.5" ${HALO}/>`,
    `<circle cx="12" cy="12" r="9" ${FILL_INK}/>`,
    `<circle cx="12" cy="12" r="5.5" ${FILL_SURFACE}/>`,
  ),
  astronaut: svgSymbol(
    `<circle cx="12" cy="12" r="10.5" ${HALO}/>`,
    `<circle cx="12" cy="12" r="9" ${FILL_SURFACE} ${INK_OUTLINE}/>`,
    `<circle cx="12" cy="9" r="2.4" ${FILL_INK}/>`,
    `<path d="M7.5 17.5Q12 9.5 16.5 17.5Z" ${FILL_INK}/>`,
  ),
  vehicle: svgSymbol(
    `<rect x="1.5" y="5" width="21" height="14" ${HALO}/>`,
    `<rect x="3.5" y="7" width="17" height="10" ${FILL_INK}/>`,
    `<rect x="6" y="9.5" width="5" height="5" ${FILL_SURFACE}/>`,
    `<rect x="14" y="3" width="4" height="3" ${FILL_INK}/>`,
    `<rect x="14" y="18" width="4" height="3" ${FILL_INK}/>`,
  ),
  base: svgSymbol(
    `<rect x="1" y="1" width="22" height="22" ${HALO}/>`,
    `<rect x="3" y="3" width="18" height="18" ${FILL_INK}/>`,
    housePath("var(--surface)"),
  ),
  supply: svgSymbol(
    `<rect x="2" y="2" width="20" height="20" ${HALO}/>`,
    `<rect x="4" y="4" width="16" height="16" ${FILL_SURFACE} ${INK_OUTLINE}/>`,
    '<path d="M4 4L20 20M20 4L4 20" stroke="var(--ink)" stroke-width="1.6"/>',
  ),
  equipment: svgSymbol(
    `<path d="M12 1.5L21 6.75V17.25L12 22.5L3 17.25V6.75Z" ${HALO}/>`,
    `<path d="M12 3.5L19.2 7.7V16.3L12 20.5L4.8 16.3V7.7Z" ${FILL_SURFACE} ${INK_OUTLINE}/>`,
    `<circle cx="12" cy="12" r="2.6" ${FILL_INK}/>`,
  ),
  refuge: svgSymbol(signSymbol("s-refuge")),
  relay: svgSymbol(signSymbol("s-relay")),
  hazard: svgSymbol(warningTriangle(
    '<path d="M12 9.5V15" stroke="var(--ink)" stroke-width="2.4"/>'
    + '<circle cx="12" cy="18" r="1.4" fill="var(--ink)"/>',
  )),
  storm: svgSymbol(warningTriangle(
    '<path d="M7 14.5Q9.5 11.5 12 14.5T17 14.5M7.5 18Q10 15.5 12 18T16.5 18"'
    + ' fill="none" stroke="var(--ink)" stroke-width="1.8"/>',
  )),
  fault: svgSymbol(
    `<path d="${ZIGZAG}" fill="none" stroke="var(--ground)" stroke-width="6"/>`,
    `<path d="${ZIGZAG}" fill="none" stroke="var(--ink)" stroke-width="2.5"/>`,
  ),
  sample: svgSymbol(
    `<path d="M12 1.5L22.5 12L12 22.5L1.5 12Z" ${HALO}/>`,
    `<path d="M12 3.5L20.5 12L12 20.5L3.5 12Z" ${FILL_INK}/>`,
    `<circle cx="12" cy="12" r="2.6" ${FILL_SURFACE}/>`,
  ),
  note: svgSymbol(
    `<path d="M4 2H15.5L20 6.5V22H4Z" ${HALO}/>`,
    `<path d="M5 3H15L19 7V21H5Z" ${FILL_SURFACE} stroke="var(--ink)" stroke-width="1.6"/>`,
    '<path d="M8 11H16M8 14.5H16M8 18H13" stroke="var(--ink)" stroke-width="1.4"/>',
  ),
  site: svgSymbol(
    '<path d="M6 22V2" stroke="var(--ground)" stroke-width="6"/>',
    `<path d="M6 2H21L15 8L21 14H6Z" ${HALO}/>`,
    '<path d="M6 22V2" stroke="var(--ink)" stroke-width="2.4"/>',
    `<path d="M7 3.5H18L13.5 8L18 12.5H7Z" ${FILL_INK}/>`,
  ),
  crater: svgSymbol(
    '<circle cx="12" cy="12" r="9" fill="none" stroke="var(--ground)" stroke-width="5"/>',
    '<circle cx="12" cy="12" r="9" fill="none" stroke="var(--ink)" stroke-width="2"'
    + ' stroke-dasharray="4 2.5"/>',
  ),
  wind: svgSymbol(
    `<path d="M12 1.5L19 13H14.5V22.5H9.5V13H5Z" ${HALO}/>`,
    `<path d="M12 3.8L16.6 11.5H13.2V20.5H10.8V11.5H7.4Z" ${FILL_INK}/>`,
  ),
};

const MARKER_PRIORITY = { me: 9, dest: 8, start: 7, refuge: 7, storm: 6, hazard: 6, wind: 3 };
const DEFAULT_PRIORITY = 5;
const markerPriority = (kind) => MARKER_PRIORITY[kind] ?? DEFAULT_PRIORITY;

function symbolMarker(item) {
  const isLive = Boolean(item.id || item.onClick);
  const selected = state.ui.selected;
  const isSelected = selected && selected.kind === item.kind && selected.id === (item.id ?? null);
  const kind = String(item.kind).replace(/[^\w-]/g, "");
  const className = [
    "mk",
    `mk-${kind}`,
    item.stale && "stale",
    item.provisional && "prov",
    item.tone === "danger" && "danger",
    isSelected && "sel",
  ].filter(Boolean).join(" ");
  const markerId = esc(`${item.kind}:${item.id ?? ""}`);
  const offsetY = Number(item.dy) || 0;
  const angle = Number(item.rotate) || 0;
  const symbol = SYMBOLS[item.kind] ?? SYMBOLS.note;
  const html = `<div class="${className}" data-mk="${markerId}">`
    + `<div class="sym" style="transform:translateY(${offsetY}px) rotate(${angle}deg)">`
    + `${symbol}</div></div>`;

  const marker = L.marker(cellToLatLng(item.cell), {
    pane: "markers",
    icon: L.divIcon({ className: "mk-wrap", html, iconSize: [0, 0] }),
    interactive: isLive,
    keyboard: isLive,
    zIndexOffset: markerPriority(item.kind) * 1000,
    title: [item.label, item.sub].filter(Boolean).join(" · "),
  });
  marker.item = item;
  if (isLive) {
    marker.on("click", () => {
      const current = marker.item;
      set("ui", { selected: { kind: current.kind, id: current.id ?? null } });
      current.onClick?.(current);
    });
  }
  return marker;
}

function plateMarker(item) {
  const priority = markerPriority(item.kind) - (item.optional ? 3 : 0);
  const className = `plate${item.optional ? " opt" : ""}${item.dy ? " dy" : ""}`;
  const marginTop = Number(item.dy) || 0;
  const sub = item.sub ? `<span>${esc(item.sub)}</span>` : "";
  const html = `<div class="${className}" data-p="${priority}" style="margin-top:${marginTop}px">`
    + `<b>${esc(item.label)}</b>${sub}</div>`;

  return L.marker(cellToLatLng(item.cell), {
    pane: "plates",
    icon: L.divIcon({ className: "plate-wrap", html, iconSize: [0, 0] }),
    interactive: false,
    keyboard: false,
    zIndexOffset: markerPriority(item.kind) * 1000,
  });
}

function ring(item) {
  const [lat, lng] = cellToLatLng(item.cell);
  const radius = item.radius_m / METERS_PER_DEGREE;
  const points = Array.from({ length: RING_POINTS }, (_, i) => {
    const angle = (i / RING_POINTS) * 2 * Math.PI;
    return [lat + radius * Math.sin(angle), lng + radius * Math.cos(angle)];
  });
  const lineOptions = { pane: "lines", interactive: false, fill: false };
  return L.layerGroup([
    L.polygon(points, { ...lineOptions, color: resolveColor("--ground"), weight: 4.5 }),
    L.polygon(points, {
      ...lineOptions,
      color: resolveColor("--ink"),
      weight: 1.5,
      dashArray: "6 4",
    }),
  ]);
}

function markerKey(item) {
  return JSON.stringify([
    item.cell,
    item.kind,
    item.label,
    item.sub,
    item.stale,
    item.provisional,
    item.rotate,
    item.radius_m,
    item.optional,
    item.dy,
    item.tone,
    Boolean(item.id || item.onClick),
  ]);
}

function hasValidCell(item, layerId) {
  if (Number.isInteger(item?.cell) && item.cell >= 0) return true;
  console.warn(`map.markers(${layerId}): item without a valid cell skipped`, item);
  return false;
}

function markers(id, list) {
  if (id.startsWith("layers:")) killLegacy();
  if (!list?.length) return put(id, null);

  const validItems = list.filter((item) => hasValidCell(item, id));
  const old = items.get(id);
  const group = old?.layer ?? L.layerGroup();
  const parts = new Map();

  validItems.forEach((item, i) => {
    const partId = item.id != null ? `${item.kind}:${item.id}` : `${item.kind}#${i}`;
    const key = markerKey(item);
    const previous = old?.parts.get(partId);
    if (previous && previous.key === key) {
      previous.layers[0].item = item;
      parts.set(partId, previous);
      return;
    }
    previous?.layers.forEach((layer) => group.removeLayer(layer));

    const layers = [symbolMarker(item)];
    if (item.label) layers.push(plateMarker(item));
    if (item.radius_m) layers.push(ring(item));
    layers.forEach((layer) => group.addLayer(layer));
    parts.set(partId, { key, layers });
  });

  old?.parts.forEach((part, partId) => {
    if (!parts.has(partId)) part.layers.forEach((layer) => group.removeLayer(layer));
  });
  items.set(id, { layer: group, parts });
  if (!hidden.has(id) && !map.hasLayer(group)) group.addTo(map);
  declutter();
}

function declutter() {
  cancelAnimationFrame(declutterFrame);
  declutterFrame = requestAnimationFrame(placePlates);
}

const FIXED_UI_SELECTOR = [
  ".map-tools .tool",
  ".map-scale",
  ".map-readout",
  ".leaflet-control-attribution",
  ".map-note:not([hidden])",
  ".map-pick:not([hidden])",
].join(", ");

const PLATE_POSITIONS = [[], ["flip"], ["dn"], ["up"], ["flip", "dn"], ["flip", "up"]];
const PLATE_POSITION_CLASSES = ["flip", "dn", "up"];

const rectOf = (el) => el.getBoundingClientRect();

function overlapsAny(rect, others) {
  return others.some((other) => (
    rect.left < other.right
    && rect.right > other.left
    && rect.top < other.bottom
    && rect.bottom > other.top
  ));
}

function placePlates() {
  const hostRect = rectOf(host);
  const plates = [...host.querySelectorAll(".plate")];
  const stage = host.closest(".map-stage") ?? host.parentElement;
  const fixedRects = [...stage.querySelectorAll(FIXED_UI_SELECTOR)].map(rectOf);
  const symbols = [...host.querySelectorAll(".mk .sym")].map((el) => {
    const rect = rectOf(el);
    return { rect, cx: (rect.left + rect.right) / 2, cy: (rect.top + rect.bottom) / 2 };
  });
  const placed = [];

  const fitsInHost = (rect) => (
    rect.left >= hostRect.left + 2
    && rect.right <= hostRect.right - 2
    && rect.top >= hostRect.top + 2
    && rect.bottom <= hostRect.bottom - 2
  );

  plates.forEach((plate) => plate.classList.remove("hide", ...PLATE_POSITION_CLASSES));

  const priority = (plate) => Number(plate.dataset.p) || 0;
  const byPriority = [...plates].sort((a, b) => priority(b) - priority(a));

  for (const plate of byPriority) {
    const anchor = rectOf(plate.parentElement);
    const isGraticuleLabel = plate.classList.contains("g");
    const otherSymbols = symbols
      .filter((symbol) => Math.hypot(symbol.cx - anchor.left, symbol.cy - anchor.top) > 3)
      .map((symbol) => symbol.rect);
    const blockers = [...fixedRects, ...otherSymbols];
    const isFree = (rect) => (
      fitsInHost(rect) && !overlapsAny(rect, placed) && !overlapsAny(rect, blockers)
    );

    let found = false;
    for (const position of isGraticuleLabel ? [[]] : PLATE_POSITIONS) {
      plate.classList.remove(...PLATE_POSITION_CLASSES);
      plate.classList.add(...position);
      found = isFree(rectOf(plate));
      if (found) break;
    }
    if (found) {
      placed.push(rectOf(plate));
    } else {
      plate.classList.remove(...PLATE_POSITION_CLASSES);
      plate.classList.add("hide");
    }
  }
}

const isNarrowScreen = () => matchMedia("(max-width: 899px)").matches;

function finishPick(result) {
  const current = picker;
  if (!current) return;
  picker = null;
  current.layer?.remove();
  host.classList.remove("picking");
  pickBox.hidden = true;
  if (scrollBeforePick != null) {
    scrollTo({ top: scrollBeforePick, behavior: "instant" });
    scrollBeforePick = null;
  }
  current.done(result);
}

function startPick(kind, promptKey) {
  finishPick(null);
  return new Promise((done) => {
    const points = [];

    const drawPoints = () => {
      picker.layer?.remove();
      const latLngs = points.map(cellToLatLng);
      const style = { pane: "lines", interactive: false };
      picker.layer = L.layerGroup([
        L.polyline(latLngs, {
          ...style,
          color: resolveColor("--ink"),
          weight: 2,
          dashArray: "6 4",
        }),
        ...latLngs.map((latLng) => L.circleMarker(latLng, {
          ...style,
          radius: 5,
          color: resolveColor("--ink"),
          weight: 2,
          fillColor: resolveColor("--surface"),
          fillOpacity: 1,
        })),
      ]).addTo(map);
    };

    picker = {
      kind,
      done,
      prompt: promptKey,
      click(cell) {
        if (cell < 0) return;
        if (kind === "cell") return finishPick(cell);
        points.push(cell);
        drawPoints();
        renderPick();
      },
      undo() {
        points.pop();
        drawPoints();
        renderPick();
      },
      confirm() {
        if (points.length >= 3) finishPick(points.slice());
      },
      pointCount: () => points.length,
    };

    host.classList.add("picking");
    pickBox.hidden = false;
    renderPick();
    if (isNarrowScreen()) {
      scrollBeforePick = scrollY;
      host.scrollIntoView({ block: "start", behavior: "instant" });
    }
  });
}

function renderPick() {
  if (!picker) return;
  const isPolygon = picker.kind === "polygon";
  const count = picker.pointCount();
  const promptKey = picker.prompt ?? (isPolygon ? "map.pick.polygon" : "map.pick.cell");
  const suffix = isPolygon ? ` · ${t("map.pick.points", { n: count })}` : "";
  $("map-pick-t").textContent = t(promptKey) + suffix;

  for (const button of pickBox.querySelectorAll("[data-pk]")) {
    const action = button.dataset.pk;
    button.hidden = !isPolygon && action !== "cancel";
    if (action === "done") button.disabled = count < 3;
    if (action === "undo") button.disabled = !count;
  }
}

const SCALE_STEPS_M = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
const SCALE_MIN_BAR_PX = 110;

function formatDistance(meters) {
  if (meters >= 1000) return `${num(meters / 1000, 0)}\u00a0km`;
  return `${num(meters, 0)}\u00a0m`;
}

function drawScale() {
  const metersPerPixel = metersPerPx(map.getZoom());
  const barMeters = SCALE_STEPS_M.find(
    (meters) => meters / metersPerPixel >= SCALE_MIN_BAR_PX,
  ) ?? 5000;
  const barWidth = barMeters / metersPerPixel;
  const ticks = [0, 1, 2, 3].map((i) => `<i${i % 2 ? "" : ' class="k"'}></i>`).join("");

  const north = `<b>${ico("g-north")}</b>${esc(t("scale.north"))}`;

  scaleEl.innerHTML = `<div class="sc-row"><div class="sc-bar" style="width:${barWidth}px">`
    + `${ticks}</div><div class="sc-n" aria-hidden="true">${north}</div></div>`
    + `<div class="sc-lab" style="min-width:${barWidth}px"><span>0</span>`
    + `<span>${formatDistance(barMeters / 2)}</span><span>${formatDistance(barMeters)}</span></div>`
    + `<div class="sc-cap">${esc(t("scale.cell", { m: num(data.cellM, 0) }))}</div>`;
}

function drawReadout(latLng) {
  const point = latLng ?? map.getCenter();
  const cell = latLngToCell(point.lat, point.lng);
  const cellText = cell >= 0
    ? t("map.cell", { r: Math.floor(cell / cols), c: cell % cols })
    : t("map.outside");
  readoutEl.textContent = [
    t("grat.lon", { v: num(point.lng, 4) }),
    t("grat.lat", { v: num(point.lat, 4) }),
    cellText,
  ].join(" · ");
}

const GRATICULE_STEPS_DEG = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1];
const GRATICULE_COARSE_DEG = 0.05;

function graticuleStep(zoom) {
  const size = map.getSize();
  const minSpacingPx = size.x < 600 ? 64 : 96;
  const spacingPx = (step) => (step * METERS_PER_DEGREE) / metersPerPx(zoom);
  const fine = GRATICULE_STEPS_DEG.find((step) => spacingPx(step) >= minSpacingPx) ?? 0.1;
  const viewSpanDeg = (size.x * metersPerPx(zoom)) / METERS_PER_DEGREE;
  return viewSpanDeg >= 2 * GRATICULE_COARSE_DEG ? Math.max(fine, GRATICULE_COARSE_DEG) : fine;
}

const GraticuleLayer = L.GridLayer.extend({
  createTile(coords) {
    const leaflet = this._map;
    const zoom = coords.z;
    const ratio = Math.min(2, devicePixelRatio || 1);
    const size = this.getTileSize().x;
    const step = graticuleStep(zoom);
    const tile = document.createElement("canvas");
    const ctx = tile.getContext("2d");
    tile.width = size * ratio;
    tile.height = size * ratio;

    const tileOrigin = coords.scaleBy(this.getTileSize());
    const northWest = leaflet.unproject(tileOrigin, zoom);
    const southEast = leaflet.unproject(tileOrigin.add([size, size]), zoom);

    ctx.scale(ratio, ratio);
    ctx.strokeStyle = resolveColor("--ink");
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = 1 / ratio;
    ctx.beginPath();
    for (let lng = Math.ceil(northWest.lng / step) * step; lng <= southEast.lng; lng += step) {
      const projected = leaflet.project([northWest.lat, lng], zoom).x - tileOrigin.x;
      const x = Math.round(projected * ratio) / ratio + 0.5 / ratio;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, size);
    }
    for (let lat = Math.ceil(southEast.lat / step) * step; lat <= northWest.lat; lat += step) {
      const projected = leaflet.project([lat, northWest.lng], zoom).y - tileOrigin.y;
      const y = Math.round(projected * ratio) / ratio + 0.5 / ratio;
      ctx.moveTo(0, y);
      ctx.lineTo(size, y);
    }
    ctx.stroke();
    return tile;
  },
});

function graticuleLabel(text, style) {
  return `<span class="plate opt g" data-p="0" style="${style}">${esc(text)}</span>`;
}

function drawGraticuleLabels() {
  const size = map.getSize();
  const step = graticuleStep(map.getZoom());
  const view = map.getBounds();
  const decimals = step < 0.01 ? 3 : 2;
  const labels = [];

  for (let lng = Math.ceil(view.getWest() / step) * step; lng <= view.getEast(); lng += step) {
    const x = map.latLngToContainerPoint([view.getNorth(), lng]).x;
    if (x > 40 && x < size.x - 40) {
      const style = `left:${x}px;top:6px;transform:translateX(-50%)`;
      labels.push(graticuleLabel(t("grat.lon", { v: num(lng, decimals) }), style));
    }
  }
  for (let lat = Math.ceil(view.getSouth() / step) * step; lat <= view.getNorth(); lat += step) {
    const y = map.latLngToContainerPoint([lat, view.getWest()]).y;
    if (y > 40 && y < size.y - 90) {
      const style = `left:6px;top:${y}px;transform:translateY(-50%)`;
      labels.push(graticuleLabel(t("grat.lat", { v: num(lat, decimals) }), style));
    }
  }
  graticuleEl.innerHTML = labels.join("");
  declutter();
}

function drawNote() {
  const view = map.getBounds();
  const envelopeVisible = state.plan.envInside
    && envelopePolys.some((poly) => poly.some(([lat, lng]) => view.contains([lat, lng])));
  noteEl.hidden = !state.plan.envInside || envelopeVisible;
  noteEl.textContent = t("map.env_beyond");
}

const MIN_FORBIDDEN_REGION = 4;

function forbidVisual(forbidden) {
  const visual = new Uint8Array(forbidden.length);
  const seen = new Uint8Array(forbidden.length);

  for (let start = 0; start < forbidden.length; start++) {
    if (!forbidden[start] || seen[start]) continue;

    const region = [start];
    seen[start] = 1;
    for (let n = 0; n < region.length; n++) {
      const i = region[n];
      const row = Math.floor(i / cols);
      const col = i % cols;
      const neighbours = [
        col > 0 ? i - 1 : -1,
        col + 1 < cols ? i + 1 : -1,
        row > 0 ? i - cols : -1,
        row + 1 < rows ? i + cols : -1,
      ];
      for (const j of neighbours) {
        if (j >= 0 && forbidden[j] && !seen[j]) {
          seen[j] = 1;
          region.push(j);
        }
      }
    }
    if (region.length >= MIN_FORBIDDEN_REGION) {
      for (const i of region) visual[i] = 1;
    }
  }
  return visual;
}

function planMarkers(plan) {
  const home = plan.habitat;
  const here = plan.at?.cell;
  const isOnEva = plan.evaS > 0 && here != null && here !== home;
  const isOnGoal = isOnEva && here === plan.goal;
  const list = [];

  if (home != null) list.push({ cell: home, kind: "start", label: t("label.start") });
  if (plan.goal != null && plan.goal !== home) {
    const labelKey = plan.goal === plan.cheyava ? "label.cheyava_dest" : "label.dest";
    list.push({
      cell: plan.goal,
      kind: "dest",
      label: t(labelKey),
      tone: plan.safe === "forbidden" ? "danger" : undefined,
    });
  }
  if (isOnEva && !isOnGoal) list.push({ cell: here, kind: "me", label: t("label.eva") });

  const refugeOffset = plan.spe?.kind === "here" ? -20 : 0;
  for (const cell of plan.refuges ?? []) {
    if (cell !== home) {
      list.push({ cell, kind: "refuge", label: t("label.refuge"), dy: refugeOffset });
    }
  }
  return list;
}

function drawPlan() {
  const plan = state.plan;
  if (!plan || plan.goal == null) return;

  if (plan.route !== lastPlan.route) {
    const route = plan.route?.length > 1 ? [plan.route] : null;
    api.lines("plan:route", route, { token: "--blue", width: 4, halo: true });
  }
  if (plan.spe !== lastPlan.spe) {
    const path = plan.spe?.path.length > 1 ? [plan.spe.path] : null;
    api.lines("plan:spe", path, {
      token: "--yellow",
      width: 4,
      halo: "--ink",
      dash: [8, 6],
      cap: "butt",
    });
  }
  if (plan.forbid && plan.forbid !== lastPlan.forbid) {
    const visual = forbidVisual(plan.forbid);
    api.pattern("plan:forbid", visual, { kind: "hatch-red" });
    api.outline("plan:forbid.edge", visual, { token: "--red", width: 1, halo: false });
  }
  if (plan.envMask && !sameArray(plan.envMask, lastPlan.envMask)) {
    const outside = Uint8Array.from(plan.envMask, (inside) => (inside ? 0 : 1));
    api.wash("plan:outside", outside, "--wash-outside");
  }
  if (plan.envInside && !sameArray(plan.envInside, lastPlan.envInside)) {
    api.outline("plan:envelope", plan.envInside, { token: "--green", width: 2.5, halo: true });
    envelopePolys = items.get("plan:envelope")?.polys ?? [];
  }
  lastPlan = {
    route: plan.route,
    spe: plan.spe,
    forbid: plan.forbid,
    envMask: plan.envMask,
    envInside: plan.envInside,
  };

  api.markers("plan:sites", planMarkers(plan));
  drawNote();
}

const LEGACY_GEO_PATTERNS = {
  Aeb: { dots: [4, 0.9], a: 0.55 },
  NHjf2: { lines: [5, "h"], a: 0.55 },
  Njf: { lines: [7, "\\"], a: 0.55 },
  Nue: { lines: [7, "v"], a: 0.55 },
  cr: { lines: [8, "x"], a: 0.55 },
  Nnp1: { dots: [9, 1.4], a: 0.55 },
};

const LEGACY_ALPHA_STEPS = [0, 36, 72, 107, 143];
const VIEWSHED_VISIBLE_ALPHA = 0;
const VIEWSHED_RELAY_ALPHA = 46;
const VIEWSHED_HIDDEN_ALPHA = 128;

const legacyRanges = {};
const legacyIds = new Set();

function killLegacy() {
  if (legacyOff) return;
  legacyOff = true;
  for (const id of legacyIds) put(id, null);
  legacyIds.clear();
}

function legacyRange(layers, key) {
  if (!legacyRanges[key]) {
    let low = Infinity;
    let high = -Infinity;
    for (const value of layers[key]) {
      if (value < low) low = value;
      if (value > high) high = value;
    }
    legacyRanges[key] = [low, high];
  }
  return legacyRanges[key];
}

function viewshedPixels(layers) {
  const [r, g, b] = rgba("--ink");
  const pixels = new Uint8ClampedArray(rows * cols * 4);
  const visible = layers.viewshed;
  const relay = layers.viewshed_relay;
  for (let i = 0; i < visible.length; i++) {
    let alpha = VIEWSHED_HIDDEN_ALPHA;
    if (visible[i] > 0.5) alpha = VIEWSHED_VISIBLE_ALPHA;
    else if (relay?.[i] > 0.5) alpha = VIEWSHED_RELAY_ALPHA;
    pixels.set([r, g, b, alpha], i * 4);
  }
  return pixels;
}

function rampPixels(layers, key) {
  const [r, g, b] = rgba("--ink");
  const pixels = new Uint8ClampedArray(rows * cols * 4);
  const values = layers[key];
  const [low, high] = legacyRange(layers, key);
  const lastStep = LEGACY_ALPHA_STEPS.length - 1;
  for (let i = 0; i < values.length; i++) {
    const step = Math.min(lastStep, Math.floor((5 * (values[i] - low)) / (high - low || 1)));
    pixels.set([r, g, b, LEGACY_ALPHA_STEPS[step]], i * 4);
  }
  return pixels;
}

function legacy() {
  if (legacyOff || !data) return;
  const layers = data.layers;
  const key = state.ui.raster;
  const activeIds = new Set();
  const use = (id) => {
    activeIds.add(id);
    legacyIds.add(id);
    return id;
  };

  if (layers[key]) {
    api.wash(use("legacy:wash"), new Uint8Array(rows * cols).fill(1), "--wash-layer");
    if (key === "geo_unit") {
      for (const unit of data.geoInfo) {
        if (!LEGACY_GEO_PATTERNS[unit.symbol]) continue;
        const mask = Uint8Array.from(layers.geo_unit, (value) => (value === unit.id ? 1 : 0));
        api.pattern(use(`legacy:geo.${unit.id}`), mask, { kind: LEGACY_GEO_PATTERNS[unit.symbol] });
      }
      api.outline(use("legacy:geo.edges"), layers.geo_unit, {
        token: "--ink",
        width: 1,
        halo: false,
      });
    } else {
      const pixels = key === "viewshed" ? viewshedPixels(layers) : rampPixels(layers, key);
      image(use("legacy:raster"), pixels, "raster");
      if (key === "viewshed" && data.meta.relay) {
        const [relayRow, relayCol] = data.meta.relay.cell;
        api.markers(use("legacy:relay"), [{
          cell: relayRow * cols + relayCol,
          kind: "relay",
          label: t("label.relay"),
        }]);
      }
    }
  }

  const showTraverse = state.ui.show.traverse !== false && data.traverse.length > 1;
  api.lines(use("legacy:traverse"), showTraverse ? [data.traverse] : null, {
    token: "--ink",
    width: 1,
    dash: [4, 4],
    opacity: 0.6,
    cap: "butt",
  });

  for (const id of [...legacyIds]) {
    if (!activeIds.has(id)) {
      put(id, null);
      legacyIds.delete(id);
    }
  }
}

const api = {
  raster(id, pixels, { opacity = 1 } = {}) {
    image(id, pixels, "raster", opacity);
  },

  pattern(id, mask, { kind = "hatch-ink" } = {}) {
    if (!mask) return put(id, null);
    const existing = items.get(id);
    const sameKind = existing && (
      existing.layer.kind === kind
      || JSON.stringify(existing.layer.kind) === JSON.stringify(kind)
    );
    if (sameKind) {
      existing.layer.mask = mask;
      existing.layer.redraw();
      return;
    }
    const layer = new PatternLayer({
      pane: "pattern",
      bounds: L.latLngBounds(gridBounds),
      tileSize: 256,
      keepBuffer: 1,
    });
    layer.mask = mask;
    layer.kind = kind;
    put(id, layer);
  },

  wash(id, mask, token = "--wash-outside") {
    if (!mask) return put(id, null);
    const color = rgba(token);
    const pixels = new Uint8ClampedArray(mask.length * 4);
    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) pixels.set(color, i * 4);
    }
    image(id, pixels, "wash");
  },

  outline(id, mask, options = {}) {
    if (!mask) return put(id, null);
    const polys = chain(maskSegments(mask, options.skip));
    strokes(id, polys, "outline", {
      token: "--green",
      width: 2.5,
      halo: true,
      join: "miter",
      cap: "square",
      ...options,
    });
    const item = items.get(id);
    if (item) item.polys = polys;
  },

  lines(id, paths, options = {}) {
    const latLngPaths = paths?.map((path) => path.map(cellToLatLng));
    strokes(id, latLngPaths, "lines", { token: "--blue", width: 4, halo: true, ...options });
  },

  markers,

  show(id, visible) {
    if (visible) hidden.delete(id);
    else hidden.add(id);
    const item = items.get(id);
    if (item) {
      if (visible) item.layer.addTo(map);
      else map.removeLayer(item.layer);
    }
    if (id.startsWith("layers:")) killLegacy();
  },

  pickCell: (promptKey) => startPick("cell", promptKey),
  pickPolygon: (promptKey) => startPick("polygon", promptKey),

  flyTo(cell, zoom) {
    const latLng = cellToLatLng(cell);
    const targetZoom = zoom ?? Math.max(map.getZoom(), 16);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      map.setView(latLng, targetZoom, { animate: false });
    } else {
      map.flyTo(latLng, targetZoom, { duration: 0.8 });
    }
  },

  cellToPoint(cell) {
    const point = map.latLngToContainerPoint(cellToLatLng(cell));
    return { x: point.x, y: point.y };
  },

  get el() {
    return host;
  },

  get leaflet() {
    return map;
  },
};

const ARROW_STEPS = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

const TOOL_ICONS = {
  layers: '<path d="M12 3L22 9L12 15L2 9Z" fill="none" stroke="currentColor" stroke-width="2"/>'
    + '<path d="M2 13.5L12 19.5L22 13.5" fill="none" stroke="currentColor" stroke-width="2"/>',
  locate: '<circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" stroke-width="2"/>'
    + '<circle cx="12" cy="12" r="2" fill="currentColor"/>'
    + '<path d="M12 1V5M12 19V23M1 12H5M19 12H23" stroke="currentColor" stroke-width="2"/>',
  fit: '<path d="M3 9V3H9M15 3H21V9M21 15V21H15M9 21H3V15" fill="none"'
    + ' stroke="currentColor" stroke-width="2.25"/>',
  guide: '<path d="M3 8V3H8M16 3H21V8M21 16V21H16M8 21H3V16" fill="none"'
    + ' stroke="currentColor" stroke-width="2.25"/>'
    + '<path d="M9 15V11H15" fill="none" stroke="currentColor" stroke-width="2"/>'
    + '<path d="M14 8.5L17 11L14 13.5Z" fill="currentColor"/>',
  report: '<path d="M4 3H20V21H4Z" fill="none" stroke="currentColor" stroke-width="2"/>'
    + '<path d="M12 8V16M8 12H16" stroke="currentColor" stroke-width="2.25"/>',
};

function centerCell() {
  const center = map.getCenter();
  return latLngToCell(center.lat, center.lng);
}

function addTool(box, id, inner, key, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tool";
  button.dataset.tool = id;
  button.dataset.i18nAria = key;
  button.dataset.i18nTitle = key;
  button.setAttribute("aria-label", t(key));
  button.title = t(key);
  button.innerHTML = inner;
  button.addEventListener("click", onClick);
  box.append(button);
  return button;
}

function buildTools() {
  const box = $("map-tools");
  const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${TOOL_ICONS[name]}</svg>`;

  addTool(box, "zoom-in", "+", "map.zoom_in", () => map.zoomIn());
  addTool(box, "zoom-out", "−", "map.zoom_out", () => map.zoomOut());
  addTool(box, "fit", icon("fit"), "map.fit", fit);
  addTool(box, "locate", icon("locate"), "map.locate", () => {
    api.flyTo(state.ui.me?.manualCell ?? state.plan.at?.cell ?? state.data.habitat);
  });
  const layersButton = addTool(box, "layers", icon("layers"), "map.layers", () => {
    set("ui", { drawer: !state.ui.drawer });
  });
  addTool(box, "report", icon("report"), "map.report", () => emit("map:report"));
  addTool(box, "guide", icon("guide"), "map.guide", () => set("ui", { guide: true }));
  return layersButton;
}

const insideZoom = () => map.getBoundsZoom(tileBounds, true);

function limitZoom() {
  map.setMinZoom(Math.max(9, insideZoom()));
}

function fit() {
  const zoom = insideZoom();
  const fitsWholeGrid = map.getBoundsZoom(gridBounds) >= zoom;
  const center = fitsWholeGrid
    ? L.latLngBounds(gridBounds).getCenter()
    : cellToLatLng(data.habitat);
  map.setView(center, zoom, { animate: false });
}

function snapToTileGrid(bound, round) {
  return round(bound / TILE_DEG) * TILE_DEG;
}

function computeTileBounds() {
  const [[south, west], [north, east]] = gridBounds;
  return [
    [
      snapToTileGrid(south - TILE_MARGIN_DEG, Math.floor),
      snapToTileGrid(west - TILE_MARGIN_DEG, Math.floor),
    ],
    [
      snapToTileGrid(north + TILE_MARGIN_DEG, Math.ceil),
      snapToTileGrid(east + TILE_MARGIN_DEG, Math.ceil),
    ],
  ];
}

function addGridOutline() {
  const strokes = [
    { color: "--halo", weight: 4, dashArray: null },
    { color: "--ink", weight: 2, dashArray: "8 6" },
  ];
  for (const { color, weight, dashArray } of strokes) {
    L.rectangle(gridBounds, {
      pane: "outline",
      interactive: false,
      fill: false,
      color: resolveColor(color),
      weight,
      opacity: 1,
      dashArray,
    }).addTo(map);
  }
}

function addBaseLayers() {
  const [[south, west], [north, east]] = gridBounds;
  const tilesArea = L.latLngBounds(
    [south - TILE_MARGIN_DEG, west - TILE_MARGIN_DEG],
    [north + TILE_MARGIN_DEG, east + TILE_MARGIN_DEG],
  );
  const tileOptions = {
    attribution: ATTRIBUTION,
    pane: "base",
    maxZoom: 19,
    bounds: tilesArea,
    errorTileUrl: BLANK_TILE,
  };

  const background = L.imageOverlay("data/hirise_aoi.webp", gridBounds, {
    attribution: ATTRIBUTION,
    pane: "base",
    interactive: false,
    zIndex: 0,
  });
  background.on("error", () => toast(t("map.nobg"), "warning"));
  background.addTo(map);

  L.tileLayer("tiles/{z}/{y}/{x}.webp", {
    ...tileOptions,
    minNativeZoom: 13,
    maxNativeZoom: 16,
    zIndex: 1,
  }).addTo(map);
  L.tileLayer("tiles/{z}/{y}/{x}.webp", {
    ...tileOptions,
    minZoom: 17,
    minNativeZoom: 17,
    maxNativeZoom: 17,
    zIndex: 2,
  }).addTo(map);
  addGridOutline();
  new GraticuleLayer({
    pane: "graticule",
    bounds: L.latLngBounds(gridBounds).pad(0.25),
    tileSize: 256,
  }).addTo(map);
}

function addOverlayElements() {
  const bar = $("map-bar");
  const addBarItem = (className) => {
    const element = document.createElement("div");
    element.className = className;
    bar.append(element);
    return element;
  };
  readoutEl = addBarItem("map-readout");
  scaleEl = addBarItem("map-scale");
  const attribution = L.control.attribution({ position: "bottomleft", prefix: false });
  bar.append(attribution.addTo(map).getContainer());

  graticuleEl = L.DomUtil.create("div", "map-grat", host);
  graticuleEl.setAttribute("aria-hidden", "true");
  noteEl = L.DomUtil.create("p", "map-note", host);
  noteEl.hidden = true;

  host.insertAdjacentHTML("beforeend",
    '<div class="map-cross" aria-hidden="true"></div>'
    + '<div class="map-pick" hidden role="status"><span id="map-pick-t"></span>'
    + '<span class="pk"><button type="button" data-pk="undo"></button>'
    + '<button type="button" data-pk="done"></button>'
    + '<button type="button" data-pk="cancel"></button></span></div>');
  pickBox = host.querySelector(".map-pick");
  pickBox.addEventListener("click", (event) => {
    const action = event.target.dataset?.pk;
    if (action === "cancel") finishPick(null);
    else if (action === "done") picker?.confirm();
    else if (action === "undo") picker?.undo();
  });
  L.DomEvent.disableClickPropagation(pickBox);
}

function setPickLabels() {
  for (const button of pickBox.querySelectorAll("[data-pk]")) {
    button.textContent = t(`map.pick.${button.dataset.pk}`);
  }
}

function keepMapFitted() {
  let fitted = false;
  let touched = false;
  let resizeFrame;

  for (const eventName of ["wheel", "pointerdown", "keydown"]) {
    host.addEventListener(eventName, () => {
      touched = true;
    }, { passive: true });
  }

  let guideOn = !!state.ui.guide;
  on("ui", (ui) => {
    if (!!ui.guide === guideOn) return;
    guideOn = !!ui.guide;
    touched = false;
  });

  const fitOnce = () => {
    if (fitted || !host.clientWidth || !host.clientHeight) return;
    fitted = true;
    map.invalidateSize({ pan: false });
    fit();
    limitZoom();
  };

  new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (!fitted) {
        fitOnce();
        return;
      }
      map.invalidateSize({ pan: false });
      if (!touched) {
        map.setMinZoom(9);
        fit();
      }
      limitZoom();
    });
  }).observe(host);

  map.setView(L.latLngBounds(gridBounds).getCenter(), 12, { animate: false });
  fitOnce();
}

function moveGoalWithArrows(event, step) {
  const goal = state.plan.goal;
  if (!Number.isInteger(goal)) return;
  event.preventDefault();
  const distance = event.shiftKey ? 10 : 1;
  const row = Math.floor(goal / cols) + step[0] * distance;
  const col = (goal % cols) + step[1] * distance;
  const clampedRow = Math.min(rows - 1, Math.max(0, row));
  const clampedCol = Math.min(cols - 1, Math.max(0, col));
  setGoal(clampedRow * cols + clampedCol);
}

function handleHostKeydown(event) {
  const step = ARROW_STEPS[event.key];
  if (event.target === host && event.altKey && step) {
    moveGoalWithArrows(event, step);
    return;
  }
  if (event.target !== host || event.key !== "Enter") return;

  const cell = centerCell();
  if (cell < 0) return;
  event.preventDefault();
  if (picker) picker.click(cell);
  else if (event.shiftKey) emit("map:here", cell);
  else setGoal(cell);
}

function bindMapEvents() {
  map.on("click", (event) => {
    const cell = latLngToCell(event.latlng.lat, event.latlng.lng);
    drawReadout(event.latlng);
    if (picker) return picker.click(cell);
    if (state.ui.selected) set("ui", { selected: null });
    if (cell >= 0 && !state.ui.guide) setGoal(cell);
  });
  map.on("mousemove", (event) => {
    isHovering = true;
    drawReadout(event.latlng);
  });
  host.addEventListener("mouseleave", () => {
    isHovering = false;
    drawReadout();
  });
  map.on("moveend zoomend", () => {
    if (!isHovering) drawReadout();
    drawNote();
    declutter();
  });
  map.on("move zoom", drawGraticuleLabels);
  map.on("zoom zoomend", drawScale);

  host.addEventListener("keydown", handleHostKeydown);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && picker) {
      event.stopPropagation();
      finishPick(null);
    }
  }, true);
}

function markSelected(selected) {
  for (const el of host.querySelectorAll("[data-mk]")) {
    const isSelected = Boolean(selected)
      && el.dataset.mk === `${selected.kind}:${selected.id ?? ""}`;
    el.classList.toggle("sel", isSelected);
  }
}

export async function init(config) {
  if (!L) throw new Error("Leaflet (vendor/leaflet/leaflet.js) is not loaded");
  data = config.data;
  ({ rows, cols } = data);
  setGrid(data.meta);
  gridBounds = bounds();
  tileBounds = computeTileBounds();
  host = $("map");

  map = L.map(host, {
    crs: L.CRS.EPSG4326,
    minZoom: 9,
    maxZoom: 19,
    zoomSnap: 0.25,
    maxBounds: tileBounds,
    maxBoundsViscosity: 1,
    preferCanvas: true,
    zoomControl: false,
    attributionControl: false,
    doubleClickZoom: false,
    wheelPxPerZoomLevel: 90,
  });
  for (const [name, zIndex] of Object.entries(PANES)) {
    map.createPane(name).style.zIndex = zIndex;
  }

  addBaseLayers();
  addOverlayElements();
  const layersButton = buildTools();
  keepMapFitted();
  bindMapEvents();

  const refreshTexts = () => {
    setPickLabels();
    drawScale();
    drawReadout();
    drawGraticuleLabels();
    drawNote();
    renderPick();
    lastPlan = {};
    drawPlan();
  };

  on("plan", drawPlan);
  on("ui", (ui) => {
    layersButton.setAttribute("aria-pressed", String(!!ui.drawer));
    if (ui.selected !== lastUi.selected) markSelected(ui.selected);
    if (ui.raster !== lastUi.raster || ui.show?.traverse !== lastUi.traverse) legacy();
    lastUi = { selected: ui.selected, raster: ui.raster, traverse: ui.show?.traverse };
  });
  on("lang", refreshTexts);

  $("status").hidden = true;
  refreshTexts();
  legacy();
  declutter();
  return api;
}
