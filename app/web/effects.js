export function overlay({ rows, cols }) {
  return { mult: new Float32Array(rows * cols).fill(1), blocked: 0 };
}
export const entryCells = (entry) => new Int32Array(0);
export const lockCells = (lock) => new Int32Array(0);
