import test from "node:test";
import assert from "node:assert/strict";
import { createGame, reveal, toggleFlag, neighborsOf, flagsLeft } from "../logic.mjs";

const lcg = (seed) => () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

test("corner cell has exactly 3 neighbors", () => {
  const g = createGame({ rows: 9, cols: 9, mines: 10 });
  assert.equal(neighborsOf(g, 0).length, 3);
  assert.equal(neighborsOf(g, 40).length, 8);
});

test("first click is never a mine", () => {
  const g = createGame({ rows: 9, cols: 9, mines: 20, rng: lcg(7) });
  reveal(g, 40);
  assert.equal(g.cells[40].mine, false);
  assert.notEqual(g.status, "lost");
});

test("flag prevents reveal and counts down", () => {
  const g = createGame({ rows: 9, cols: 9, mines: 10, rng: lcg(1) });
  toggleFlag(g, 5);
  assert.equal(flagsLeft(g), 9);
  assert.deepEqual(reveal(g, 5), []);
  assert.equal(g.cells[5].revealed, false);
});

test("clicking a mine loses", () => {
  const g = createGame({ rows: 9, cols: 9, mines: 10, rng: lcg(3) });
  reveal(g, 40);
  const mineIdx = g.cells.findIndex((c) => c.mine);
  reveal(g, mineIdx);
  assert.equal(g.status, "lost");
});

test("revealing all safe cells wins", () => {
  const g = createGame({ rows: 5, cols: 5, mines: 3, rng: lcg(11) });
  reveal(g, 0);
  for (let i = 0; i < g.cells.length; i++) {
    if (!g.cells[i].mine) reveal(g, i);
  }
  assert.equal(g.status, "won");
});

test("zero cell flood-reveals neighbors", () => {
  const g = createGame({ rows: 9, cols: 9, mines: 5, rng: lcg(99) });
  const changed = reveal(g, 40);
  if (g.cells[40].count === 0) assert.ok(changed.length > 1);
});
