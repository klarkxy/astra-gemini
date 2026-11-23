import { createGame, reveal, toggleFlag, flagsLeft } from "./logic.mjs";

const LEVELS = {
  easy: { rows: 9, cols: 9, mines: 10 },
  medium: { rows: 16, cols: 16, mines: 40 },
  hard: { rows: 16, cols: 30, mines: 99 }
};

const board = document.getElementById("board");
const counter = document.getElementById("counter");
const face = document.getElementById("face");
const timerEl = document.getElementById("timer");
const levelSel = document.getElementById("level");

let g, startedAt, timerId;

function newGame() {
  g = createGame(LEVELS[levelSel.value]);
  startedAt = null;
  clearInterval(timerId);
  timerEl.textContent = "0";
  render();
}

function startTimer() {
  if (startedAt) return;
  startedAt = Date.now();
  timerId = setInterval(() => {
    timerEl.textContent = Math.floor((Date.now() - startedAt) / 1000);
  }, 250);
}

function render() {
  board.style.gridTemplateColumns = `repeat(${g.cols}, 30px)`;
  board.innerHTML = "";
  g.cells.forEach((cell, i) => {
    const b = document.createElement("button");
    b.className = "cell";
    b.dataset.i = i;
    if (cell.revealed) {
      b.classList.add("open");
      if (cell.mine) b.textContent = "💥";
      else if (cell.count) { b.textContent = cell.count; b.dataset.n = cell.count; }
    } else if (g.status === "lost" && cell.mine && !cell.flagged) {
      b.classList.add("open");
      b.textContent = "💣";
    } else if (cell.flagged) {
      b.textContent = "🚩";
    }
    board.appendChild(b);
  });
  counter.textContent = flagsLeft(g);
  face.textContent = g.status === "won" ? "😎" : g.status === "lost" ? "😵" : "🙂";
}

board.addEventListener("click", (e) => {
  const b = e.target.closest(".cell");
  if (!b || g.status !== "playing") return;
  startTimer();
  reveal(g, Number(b.dataset.i));
  render();
});

board.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const b = e.target.closest(".cell");
  if (!b || g.status !== "playing") return;
  startTimer();
  toggleFlag(g, Number(b.dataset.i));
  render();
});

face.addEventListener("click", newGame);
levelSel.addEventListener("change", newGame);
newGame();
