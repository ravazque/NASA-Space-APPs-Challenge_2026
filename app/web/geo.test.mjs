import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setGrid, cellToLatLng, latLngToCell, bounds, maskSegments, cellsInPolygon, cellsInCircle, metersPerPx } from "./geo.js";

const meta = JSON.parse(readFileSync(new URL("./data/jezero_cost_grid.json", import.meta.url), "utf8")).meta;
const { rows, cols } = meta;
setGrid(meta);

test("every corner cell and both sites round trip through lat/lng", () => {
  for (const i of [0, cols - 1, (rows - 1) * cols, rows * cols - 1, ...Object.values(meta.sites).map((s) => s.cell[0] * cols + s.cell[1])]) {
    const [lat, lng] = cellToLatLng(i);
    assert.equal(latLngToCell(lat, lng), i);
  }
  assert.equal(latLngToCell(...cellToLatLng(154 * cols + 335)), 154 * cols + 335);
});

test("the sites' real lon/lat fall in the cells the grid lists", () => {
  for (const s of Object.values(meta.sites)) assert.equal(latLngToCell(s.lat, s.lon), s.cell[0] * cols + s.cell[1], s.name);
});

test("bounds are the grid edge, and cells just outside are -1", () => {
  const [[latS, lonW], [latN, lonE]] = bounds();
  assert.ok(latN > latS && lonE > lonW);
  assert.equal(latLngToCell(latN + 1e-4, lonW + 1e-3), -1);
  assert.equal(latLngToCell(latS - 1e-4, lonW + 1e-3), -1);
  assert.equal(latLngToCell(latN - 1e-3, lonE + 1e-4), -1);
  assert.equal(latLngToCell(latN - 1e-3, lonW - 1e-4), -1);
  assert.ok(Math.abs((lonE - lonW) * ((Math.PI * 3396190) / 180) - cols * meta.cell_m) < 1e-6);
});

test("maskSegments: one set cell has a 4-segment border; a full mask has none", () => {
  const m = new Uint8Array(rows * cols); m[5 * cols + 5] = 1;
  assert.equal(maskSegments(m).length, 4);
  assert.equal(maskSegments(new Uint8Array(rows * cols).fill(1)).length, 0);
});

test("cellsInPolygon and cellsInCircle", () => {
  const sq = [10 * cols + 10, 10 * cols + 20, 20 * cols + 20, 20 * cols + 10];
  assert.equal(cellsInPolygon(sq).length, 100);
  assert.equal(cellsInPolygon(sq.slice(0, 2)).length, 0);
  assert.deepEqual([...cellsInCircle(50 * cols + 50, 0)], [50 * cols + 50]);
  assert.equal(cellsInCircle(50 * cols + 50, 20).length, 5);
});

test("metersPerPx halves per zoom and matches the Mars sphere", () => {
  assert.ok(Math.abs(metersPerPx(15) - 1.27190) < 1e-4);
  assert.ok(Math.abs(metersPerPx(16) * 2 - metersPerPx(15)) < 1e-12);
});

test("Leaflet EPSG4326 tile index of the sites equals NASA Trek's row/col at z16", () => {
  const tile = (lat, lon, z) => [Math.floor(((90 - lat) / 180) * 2 ** z), Math.floor(((lon + 180) / 360) * 2 ** (z + 1))];
  const { three_forks: tf, cheyava_falls: cf } = meta.sites;
  assert.deepEqual(tile(tf.lat, tf.lon, 16), [26049, 93719]);
  assert.deepEqual(tile(cf.lat, cf.lon, 16), [26033, 93681]);
});
