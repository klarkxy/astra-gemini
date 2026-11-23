// Minesweeper core logic — pure functions, no DOM, unit-testable.
export function createGame({ rows = 9, cols = 9, mines = 10, rng = Math.random } = {}) {
  if (mines >= rows * cols) throw new Error("too many mines");
  const cells = Array.from({ length: rows * cols }, () => ({ mine: false, count: 0, revealed: false, flagged: false }));
  return { rows, cols, mines, rng, placed: false, status: "playing", revealed: 0, cells };
}

export function neighborsOf(g, i) {
  const r = Math.floor(i / g.cols), c = i % g.cols;
  const out = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const nr = r + dr, nc = c + dc;
    if (nr >= 0 && nr < g.rows && nc >= 0 && nc < g.cols) out.push(nr * g.cols + nc);
  }
  return out;
}

function placeMines(g, safe) {
  const idx = g.cells.map((_, i) => i).filter((i) => i !== safe);
  for (let n = idx.length - 1; n > 0; n--) {
    const j = Math.floor(g.rng() * (n + 1));
    [idx[n], idx[j]] = [idx[j], idx[n]];
  }
  for (const i of idx.slice(0, g.mines)) g.cells[i].mine = true;
  for (let i = 0; i < g.cells.length; i++) {
    if (!g.cells[i].mine) g.cells[i].count = neighborsOf(g, i).filter((n) => g.cells[n].mine).length;
  }
  g.placed = true;
}

export function toggleFlag(g, i) {
  const c = g.cells[i];
  if (g.status !== "playing" || c.revealed) return false;
  c.flagged = !c.flagged;
  return true;
}

export function flagsLeft(g) {
  return g.mines - g.cells.filter((c) => c.flagged).length;
}

export function reveal(g, i) {
  if (g.status !== "playing") return [];
  const c = g.cells[i];
  if (c.flagged || c.revealed) return [];
  if (!g.placed) placeMines(g, i);
  const changed = [];
  const stack = [i];
  while (stack.length) {
    const j = stack.pop();
    const cell = g.cells[j];
    if (cell.revealed || cell.flagged) continue;
    cell.revealed = true;
    g.revealed++;
    changed.push(j);
    if (cell.mine) { g.status = "lost"; continue; }
    if (cell.count === 0) {
      for (const n of neighborsOf(g, j)) {
        if (!g.cells[n].revealed && !g.cells[n].flagged) stack.push(n);
      }
    }
  }
  if (g.revealed === g.rows * g.cols - g.mines && g.status === "playing") g.status = "won";
  return changed;
}
