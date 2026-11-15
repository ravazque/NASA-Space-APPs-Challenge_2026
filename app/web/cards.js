const $ = (id) => document.getElementById(id);

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (ch) => ESCAPES[ch]);

let selectedPhoto = 0;

function createElement(tag, props = {}) {
  const el = document.createElement(tag);
  Object.assign(el, props);
  return el;
}

function renderCaption(photo, { t, date, pick }) {
  const isPanorama = photo.file.startsWith("pano");
  const hasSource = /^https?:/.test(photo.source_url ?? "");
  const sourceLink = hasSource
    ? ` · <a href="${esc(photo.source_url)}">${esc(t("pov.source"))}</a>`
    : "";
  const meta = t("pov.meta", {
    instrument: photo.instrument,
    sol: photo.sol,
    date: date(photo.date_utc),
  });
  const dragHint = isPanorama ? `<br>${esc(t("pov.drag"))}` : "";
  return `<p>${esc(pick(photo, "caption"))}</p>`
    + `<p class="caption">${esc(meta)}<br>${esc(t("pov.credit", { credit: photo.credit }))}`
    + `${sourceLink}${dragHint}</p>`;
}

function targetIndexForKey(key, index, count) {
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index + count - 1) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

function buildPhotoViewer(photos, { t, date, pick }) {
  const scrollBefore = $("pov-panel")?.scrollLeft;
  selectedPhoto = Math.min(selectedPhoto, photos.length - 1);

  const tabs = createElement("div", { className: "tabs" });
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", t("dest.photos"));

  const view = createElement("div", { id: "pov-panel", className: "viewer", tabIndex: 0 });
  view.setAttribute("role", "tabpanel");

  const caption = createElement("div");

  const show = (index, isFirstShow) => {
    selectedPhoto = index;
    tabs.querySelectorAll("button").forEach((button, i) => {
      button.setAttribute("aria-selected", String(i === index));
      button.tabIndex = i === index ? 0 : -1;
    });

    const photo = photos[index];
    const isPanorama = photo.file.startsWith("pano");
    const img = new Image();
    img.alt = pick(photo, "caption");
    img.src = `data/pov/${photo.file}`;
    view.className = `viewer${isPanorama ? "" : " fit"}`;
    view.replaceChildren(img);
    view.setAttribute("aria-labelledby", `tab-${index}`);
    if (isPanorama) {
      img.onload = () => {
        const restore = isFirstShow && scrollBefore != null;
        view.scrollLeft = restore ? scrollBefore : view.scrollWidth * 0.66 - view.clientWidth / 2;
      };
    }

    caption.innerHTML = renderCaption(photo, { t, date, pick });

    const next = photos[(index + 1) % photos.length];
    setTimeout(() => {
      new Image().src = `data/pov/${next.file}`;
    }, 300);
  };

  photos.forEach((photo, i) => {
    const button = createElement("button", {
      type: "button",
      id: `tab-${i}`,
      textContent: t(`pov.tab.${photo.file.replace(/\.\w+$/, "")}`),
    });
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", "pov-panel");
    button.addEventListener("click", () => show(i));
    button.addEventListener("keydown", (event) => {
      const target = targetIndexForKey(event.key, i, photos.length);
      if (target == null) return;
      event.preventDefault();
      show(target);
      tabs.children[target].focus();
    });
    tabs.append(button);
  });

  const wrapper = createElement("div");
  wrapper.append(tabs, view, caption);
  show(selectedPhoto, true);
  return wrapper;
}

function buildScienceGrid(science, { t, pick }) {
  const objective = science.objective;
  const citation = science.citation;
  const grid = createElement("div", { className: "card-grid" });
  grid.innerHTML = `<div><h3>${esc(pick(objective, "headline"))}</h3>`
    + `<p>${esc(pick(objective, "summary"))}</p>`
    + `<p class="muted">${esc(pick(objective, "spots"))}</p></div>`
    + `<div><p class="note">${esc(pick(objective, "caution"))}</p>`
    + `<p class="cite-label">${esc(t("dest.cite"))}</p>`
    + `<p class="cite">${esc(citation.text)}`
    + ` <a href="${esc(citation.url)}">doi:${esc(citation.doi)}</a></p>`
    + `<p class="cite">${esc(pick(science.destination, "position_note"))}</p></div>`;
  return grid;
}

function renderDestination(detail) {
  const { science, pov } = detail.data;
  const photos = pov?.length ? pov : null;
  const card = $("destino");
  const body = $("dest-body");

  card.hidden = !science && !photos;
  if (card.hidden) return;

  const viewer = photos ? buildPhotoViewer(photos, detail) : null;
  body.replaceChildren();
  if (viewer) body.append(viewer);
  if (science) body.append(buildScienceGrid(science, detail));
}

function svgLine(x1, y1, x2, y2, extra = "") {
  return `<path d="M${x1} ${y1}L${x2} ${y2}" stroke="currentColor" stroke-width="1"`
    + ` vector-effect="non-scaling-stroke" ${extra}/>`;
}

function scatterPlot(validation, t, num) {
  const maxValue = Math.ceil(Math.max(...validation.pairs.flat()) / 5) * 5;
  const toX = (d) => 30 + (202 * d) / maxValue;
  const toY = (d) => 140 - (132 * d) / maxValue;
  const label = t("val.chart", { n: validation.n, r: num(validation.r, 2) });

  let svg = `<svg class="scatter" viewBox="0 0 240 170" role="img" aria-label="${esc(label)}">`
    + svgLine(30, 8, 30, 140)
    + svgLine(30, 140, 232, 140);

  svg += svgLine(toX(0), toY(0), toX(maxValue), toY(maxValue), 'stroke-dasharray="3 3"');
  svg += `<text x="${toX(maxValue) - 2}" y="${toY(maxValue) + 9}" text-anchor="end">1:1</text>`;

  for (let d = 0; d <= maxValue; d += 5) {
    svg += `<text x="${toX(d)}" y="150" text-anchor="middle">${d}</text>`;
    svg += `<text x="26" y="${toY(d) + 2.5}" text-anchor="end">${d}</text>`;
  }

  svg += validation.pairs.map(([modelled, reference]) => {
    const x = (toX(reference) - 1).toFixed(1);
    const y = (toY(modelled) - 1).toFixed(1);
    return `<rect x="${x}" y="${y}" width="2" height="2" fill="currentColor" fill-opacity=".45"/>`;
  }).join("");

  svg += `<text x="131" y="165" text-anchor="middle">${esc(t("val.x"))}</text>`;
  svg += `<text transform="translate(7 74) rotate(-90)" text-anchor="middle">`
    + `${esc(t("val.y"))}</text>`;
  return `${svg}</svg>`;
}

function figure(value, detail) {
  return `<div><span class="value">${esc(value)}</span><p class="detail">${esc(detail)}</p></div>`;
}

function renderValidation({ data, t, num }) {
  const { validation, cfg, traversePct, basePct } = data;
  const card = $("validacion");
  const hasPairs = Boolean(validation?.pairs?.length);
  const figures = [];

  if (Number.isFinite(traversePct)) {
    figures.push(figure(
      t("val.trav.value", { pct: num(traversePct, 1) }),
      t("val.trav.label", { base: num(basePct, 1) }),
    ));
  }
  if (hasPairs) {
    figures.push(figure(
      t("val.r.value", { r: num(validation.r, 2) }),
      t("val.r.label", { n: validation.n }),
    ));
  }

  card.hidden = !figures.length;
  if (card.hidden) return;

  const nominal = t("val.nominal", {
    speed: num(cfg.walk_speed_ms, 1),
    max: num(cfg.max_slope_deg, 0),
    budget: num(cfg.eva_energy_budget_j / 1e6, 2),
    margin: num(cfg.return_margin * 100, 0),
    g: num(cfg.gravity_ratio, 2),
  });
  $("val-body").innerHTML = `<div class="figs">${figures.join("")}</div>`
    + (hasPairs ? scatterPlot(validation, t, num) : "")
    + `<p class="cite">${esc(nominal)}</p>`;
}

function render(detail) {
  renderDestination(detail);
  renderValidation(detail);
}

document.addEventListener("ariadne:render", (event) => render(event.detail));
if (window.ARIADNE?.data && window.ARIADNE.t) render(window.ARIADNE);
