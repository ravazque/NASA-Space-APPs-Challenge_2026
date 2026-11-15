const MARS_RADIUS_M = 3396190;

const metersToDegrees = (meters) => ((meters / MARS_RADIUS_M) * 180) / Math.PI;
const degreesToMeters = (degrees) => ((degrees * Math.PI) / 180) * MARS_RADIUS_M;

let originX = 0;
let originY = 0;
let cellSize = 20;
let rows = 0;
let cols = 0;

export function setGrid(meta) {
  [originX, originY] = meta.origin_m;
  cellSize = meta.cell_m;
  rows = meta.rows;
  cols = meta.cols;
}

export function cellToLatLng(index) {
  const row = (index / cols) | 0;
  const col = index % cols;
  const lat = metersToDegrees(originY - (row + 0.5) * cellSize);
  const lng = metersToDegrees(originX + (col + 0.5) * cellSize);
  return [lat, lng];
}

export function latLngToCell(lat, lng) {
  const row = Math.floor((originY - degreesToMeters(lat)) / cellSize);
  const col = Math.floor((degreesToMeters(lng) - originX) / cellSize);
  if (row < 0 || col < 0 || row >= rows || col >= cols) return -1;
  return row * cols + col;
}

export function bounds() {
  const south = metersToDegrees(originY - rows * cellSize);
  const west = metersToDegrees(originX);
  const north = metersToDegrees(originY);
  const east = metersToDegrees(originX + cols * cellSize);
  return [[south, west], [north, east]];
}

export function maskSegments(mask, skip) {
  const segments = [];
  const corner = (row, col) => [
    metersToDegrees(originY - row * cellSize),
    metersToDegrees(originX + col * cellSize),
  ];
  const skipped = (a, b) => skip && (skip[a] || skip[b]);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      if (col + 1 < cols && mask[i] !== mask[i + 1] && !skipped(i, i + 1)) {
        segments.push([corner(row, col + 1), corner(row + 1, col + 1)]);
      }
      if (row + 1 < rows && mask[i] !== mask[i + cols] && !skipped(i, i + cols)) {
        segments.push([corner(row + 1, col), corner(row + 1, col + 1)]);
      }
    }
  }
  return segments;
}

export function cellsInPolygon(cells) {
  if (cells.length < 3) return new Int32Array(0);

  const vertices = cells.map((i) => [(i % cols) + 0.5, ((i / cols) | 0) + 0.5]);
  const xs = vertices.map((v) => v[0]);
  const ys = vertices.map((v) => v[1]);
  const rowMin = Math.max(0, Math.floor(Math.min(...ys)));
  const rowMax = Math.min(rows - 1, Math.ceil(Math.max(...ys)));
  const colMin = Math.max(0, Math.floor(Math.min(...xs)));
  const colMax = Math.min(cols - 1, Math.ceil(Math.max(...xs)));
  const inside = [];

  for (let row = rowMin; row <= rowMax; row++) {
    for (let col = colMin; col <= colMax; col++) {
      if (pointInPolygon(col + 0.5, row + 0.5, vertices)) inside.push(row * cols + col);
    }
  }
  return Int32Array.from(inside);
}

function pointInPolygon(x, y, vertices) {
  let inside = false;
  for (let a = 0, b = vertices.length - 1; a < vertices.length; b = a++) {
    const [ax, ay] = vertices[a];
    const [bx, by] = vertices[b];
    const crosses = ay > y !== by > y;
    if (crosses && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

export function cellsInCircle(center, radiusM) {
  const centerRow = (center / cols) | 0;
  const centerCol = center % cols;
  const reach = Math.ceil(radiusM / cellSize);
  const rowMin = Math.max(0, centerRow - reach);
  const rowMax = Math.min(rows - 1, centerRow + reach);
  const colMin = Math.max(0, centerCol - reach);
  const colMax = Math.min(cols - 1, centerCol + reach);
  const inside = [];

  for (let row = rowMin; row <= rowMax; row++) {
    for (let col = colMin; col <= colMax; col++) {
      if (Math.hypot(row - centerRow, col - centerCol) * cellSize <= radiusM) {
        inside.push(row * cols + col);
      }
    }
  }
  return Int32Array.from(inside);
}

export const metersPerPx = (zoom) => (MARS_RADIUS_M * Math.PI) / (256 * 2 ** zoom);
