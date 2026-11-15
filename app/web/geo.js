const R = 3396190;
const deg = (m) => ((m / R) * 180) / Math.PI, rad = (d) => (d * Math.PI) / 180 * R;
let x0 = 0, y0 = 0, cell = 20, rows = 0, cols = 0;

export function setGrid(meta) { [x0, y0] = meta.origin_m; cell = meta.cell_m; rows = meta.rows; cols = meta.cols; }

export const cellToLatLng = (i) => [deg(y0 - (((i / cols) | 0) + 0.5) * cell), deg(x0 + ((i % cols) + 0.5) * cell)];
export function latLngToCell(lat, lng) {
  const r = Math.floor((y0 - rad(lat)) / cell), c = Math.floor((rad(lng) - x0) / cell);
  return r < 0 || c < 0 || r >= rows || c >= cols ? -1 : r * cols + c;
}
export const bounds = () => [[deg(y0 - rows * cell), deg(x0)], [deg(y0), deg(x0 + cols * cell)]];

export function maskSegments(mask, skip) {
  const out = [], ll = (r, c) => [deg(y0 - r * cell), deg(x0 + c * cell)];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c;
    if (c + 1 < cols && mask[i] !== mask[i + 1] && !(skip && (skip[i] || skip[i + 1]))) out.push([ll(r, c + 1), ll(r + 1, c + 1)]);
    if (r + 1 < rows && mask[i] !== mask[i + cols] && !(skip && (skip[i] || skip[i + cols]))) out.push([ll(r + 1, c), ll(r + 1, c + 1)]);
  }
  return out;
}

export function cellsInPolygon(cells) {
  const v = cells.map((i) => [(i % cols) + 0.5, ((i / cols) | 0) + 0.5]), out = [];
  if (v.length < 3) return new Int32Array(0);
  const rs = v.map((p) => p[1]), cs = v.map((p) => p[0]);
  const r0 = Math.max(0, Math.floor(Math.min(...rs))), r1 = Math.min(rows - 1, Math.ceil(Math.max(...rs)));
  const c0 = Math.max(0, Math.floor(Math.min(...cs))), c1 = Math.min(cols - 1, Math.ceil(Math.max(...cs)));
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const x = c + 0.5, y = r + 0.5; let inside = false;
    for (let a = 0, b = v.length - 1; a < v.length; b = a++) {
      if ((v[a][1] > y) !== (v[b][1] > y) && x < ((v[b][0] - v[a][0]) * (y - v[a][1])) / (v[b][1] - v[a][1]) + v[a][0]) inside = !inside;
    }
    if (inside) out.push(r * cols + c);
  }
  return Int32Array.from(out);
}

export function cellsInCircle(c, r_m) {
  const cr = (c / cols) | 0, cc = c % cols, n = Math.ceil(r_m / cell), out = [];
  for (let r = Math.max(0, cr - n); r <= Math.min(rows - 1, cr + n); r++) for (let k = Math.max(0, cc - n); k <= Math.min(cols - 1, cc + n); k++) {
    if (Math.hypot(r - cr, k - cc) * cell <= r_m) out.push(r * cols + k);
  }
  return Int32Array.from(out);
}

export const metersPerPx = (zoom) => (R * Math.PI) / (256 * 2 ** zoom);
