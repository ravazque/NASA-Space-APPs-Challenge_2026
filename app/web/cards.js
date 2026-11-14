const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
let sel = 0;

function dest({ data: { science: sci, pov }, t, date, pick }) {
  const card = $("destino"), body = $("dest-body"), photos = pov?.length ? pov : null;
  card.hidden = !sci && !photos;
  if (card.hidden) return;
  const keep = $("pov-panel")?.scrollLeft;
  body.replaceChildren();
  if (photos) {
    sel = Math.min(sel, photos.length - 1);
    const tabs = document.createElement("div"), view = document.createElement("div"), cap = document.createElement("div");
    tabs.className = "tabs"; tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", t("dest.photos"));
    view.id = "pov-panel"; view.className = "viewer"; view.setAttribute("role", "tabpanel"); view.tabIndex = 0;
    const show = (n, first) => {
      sel = n;
      tabs.querySelectorAll("button").forEach((b, i) => { b.setAttribute("aria-selected", String(i === n)); b.tabIndex = i === n ? 0 : -1; });
      const p = photos[n], pano = p.file.startsWith("pano"), img = new Image();
      img.alt = pick(p, "caption"); img.decoding = "async"; img.src = `data/pov/${p.file}`;
      view.className = `viewer${pano ? "" : " fit"}`; view.replaceChildren(img);
      if (pano) img.onload = () => { view.scrollLeft = first && keep != null ? keep : view.scrollWidth * 0.55 - view.clientWidth / 2; };
      view.setAttribute("aria-labelledby", `tab-${n}`);
      const src = /^https?:/.test(p.source_url ?? "") ? ` · <a href="${esc(p.source_url)}">${esc(t("pov.source"))}</a>` : "";
      cap.innerHTML = `<p>${esc(pick(p, "caption"))}</p><p class="caption">${esc(t("pov.meta", { instrument: p.instrument, sol: p.sol, date: date(p.date_utc) }))}<br>${esc(t("pov.credit", { credit: p.credit }))}${src}${pano ? `<br>${esc(t("pov.drag"))}` : ""}</p>`;
      const nx = photos[(n + 1) % photos.length]; setTimeout(() => { new Image().src = `data/pov/${nx.file}`; }, 300);
    };
    photos.forEach((p, i) => {
      const b = document.createElement("button");
      b.type = "button"; b.id = `tab-${i}`; b.setAttribute("role", "tab"); b.setAttribute("aria-controls", "pov-panel");
      b.textContent = t(`pov.tab.${p.file.replace(/\.\w+$/, "")}`);
      b.addEventListener("click", () => show(i));
      b.addEventListener("keydown", (e) => {
        const j = { ArrowRight: (i + 1) % photos.length, ArrowLeft: (i + photos.length - 1) % photos.length, Home: 0, End: photos.length - 1 }[e.key];
        if (j == null) return;
        e.preventDefault(); show(j); tabs.children[j].focus();
      });
      tabs.append(b);
    });
    const wrap = document.createElement("div"); wrap.append(tabs, view, cap); body.append(wrap);
    show(sel, true);
  }
  if (sci) {
    const o = sci.objective, c = sci.citation, g = document.createElement("div");
    g.className = "card-grid";
    g.innerHTML = `<div><h3>${esc(pick(o, "headline"))}</h3><p>${esc(pick(o, "summary"))}</p><p class="muted">${esc(pick(o, "spots"))}</p></div>
      <div><p class="note">${esc(pick(o, "caution"))}</p>
      <p class="cite-label">${esc(t("dest.cite"))}</p>
      <p class="cite">${esc(c.text)} <a href="${esc(c.url)}">doi:${esc(c.doi)}</a></p>
      <p class="cite">${esc(pick(sci.destination, "position_note"))}</p></div>`;
    body.append(g);
  }
}

function scatter(v, t, num) {
  const D = Math.ceil(Math.max(...v.pairs.flat()) / 5) * 5, X = (d) => 30 + (202 * d) / D, Y = (d) => 140 - (132 * d) / D;
  const line = (a, b, c, d, x = "") => `<path d="M${a} ${b}L${c} ${d}" stroke="currentColor" stroke-width="1" vector-effect="non-scaling-stroke" ${x}/>`;
  let s = `<svg class="scatter" viewBox="0 0 240 170" role="img" aria-label="${esc(t("val.chart", { n: v.n, r: num(v.r, 2) }))}">${line(30, 8, 30, 140)}${line(30, 140, 232, 140)}`;
  s += line(X(0), Y(0), X(D), Y(D), 'stroke-dasharray="3 3"') + `<text x="${X(D) - 2}" y="${Y(D) + 9}" text-anchor="end">1:1</text>`;
  for (let d = 0; d <= D; d += 5) s += `<text x="${X(d)}" y="150" text-anchor="middle">${d}</text><text x="26" y="${Y(d) + 2.5}" text-anchor="end">${d}</text>`;
  s += v.pairs.map(([m, r]) => `<rect x="${(X(r) - 1).toFixed(1)}" y="${(Y(m) - 1).toFixed(1)}" width="2" height="2" fill="currentColor" fill-opacity=".45"/>`).join("");
  s += `<text x="131" y="165" text-anchor="middle">${esc(t("val.x"))}</text><text transform="translate(7 74) rotate(-90)" text-anchor="middle">${esc(t("val.y"))}</text></svg>`;
  return s;
}

function val({ data: { validation: v, cfg, traversePct, basePct }, t, num }) {
  const card = $("validacion"), cells = [];
  if (Number.isFinite(traversePct)) cells.push(`<div><span class="value">${esc(t("val.trav.value", { pct: num(traversePct, 1) }))}</span><p class="detail">${esc(t("val.trav.label", { base: num(basePct, 1) }))}</p></div>`);
  if (v?.pairs?.length) cells.push(`<div><span class="value">${esc(t("val.r.value", { r: num(v.r, 2) }))}</span><p class="detail">${esc(t("val.r.label", { n: v.n }))}</p></div>`);
  card.hidden = !cells.length;
  if (card.hidden) return;
  $("val-body").innerHTML = `<div class="figs">${cells.join("")}</div>${v?.pairs?.length ? scatter(v, t, num) : ""}
    <p class="cite">${esc(t("val.nominal", { speed: num(cfg.walk_speed_ms, 1), max: num(cfg.max_slope_deg, 0), budget: num(cfg.eva_energy_budget_j / 1e6, 2), margin: num(cfg.return_margin * 100, 0), g: num(cfg.gravity_ratio, 2) }))}</p>`;
}

document.addEventListener("ariadne:render", (e) => { dest(e.detail); val(e.detail); });
if (window.ARIADNE) { dest(window.ARIADNE); val(window.ARIADNE); }
