// 時事クロスワードの画面。
//
// 盤面はサーバ（/api/news/puzzle）から降ってくる。バックエンドが無い構成では、
// 同じ生成コード（crossword-core.js）をブラウザ側で回してデモ盤を出す。
// 遊び方は「もじぴったん」の要領で、手持ちの文字タイルをマスに置いていく。

import { LANG, localizeDom, t } from "./i18n.js";
import { buildPuzzle } from "./crossword-core.js";

const $ = (id) => document.getElementById(id);
const key = (x, y) => `${x},${y}`;

const el = {
  board: $("cw-board"),
  rack: $("cw-rack"),
  clues: $("cw-clues"),
  detail: $("cw-detail"),
  detailBody: $("cw-detail-body"),
  ranking: $("cw-ranking"),
  timer: $("cw-timer"),
  progress: $("cw-progress"),
  corpus: $("cw-corpus"),
  veil: $("cw-veil"),
  veilTitle: $("cw-veil-title"),
  veilNote: $("cw-veil-note"),
  start: $("cw-start"),
  ranges: $("cw-ranges"),
  result: $("cw-result"),
  resultTime: $("cw-result-time"),
  resultNote: $("cw-result-note"),
  resultForm: $("cw-result-form"),
  name: $("cw-name"),
};

const state = {
  range: "1d",
  puzzle: null,
  cells: new Map(),   // "x,y" -> 出題データのセル
  filled: new Map(),  // "x,y" -> { ch, rackIdx, given, hinted }
  rack: [],           // { ch, used }
  picked: -1,
  solved: new Set(),  // 解けた語の番号+向き
  startedAt: 0,
  penaltyMs: 0,
  finalMs: 0,
  mine: null,
  running: false,
  frame: 0,
  demo: false,
  submitted: false,
};

const entryId = (e) => `${e.num}${e.dir}`;

// ---------------------------------------------------------------- デモ用の見出し
// バックエンドが無くてもページが遊べるように、サンプルの見出しを積んでおく。
// 実在のニュースではない（このアプリ自身の話題で作った練習用の盤）。
const DEMO_TITLES = [
  "【例】グリッチ加工の作例が公開される",
  "【例】グリッチとノイズを重ねる手順",
  "【例】モザイクの粒を大きくする",
  "【例】モザイクとディザの使い分け",
  "【例】ディザリングで色数を落とす",
  "【例】ディザリングの網点表現",
  "【例】カメラロールから写真を読み込む",
  "【例】カメラの手ぶれを活かした演出",
  "【例】ブラウザだけで完結する仕組み",
  "【例】ブラウザの対応状況を確かめる",
  "【例】パレットを絞ると印象が変わる",
  "【例】パレットの作り方をまとめる",
  "【例】ハレーションを強めに効かせる",
  "【例】ハレーションと光漏れの違い",
  "【例】スキヤンラインを重ねて表示する",
  "【例】スキヤンラインの太さを調整する",
  "【例】ピクセルソートの向きを変える",
  "【例】ピクセルソートで帯を作る",
];

function demoPuzzle(range) {
  const now = Date.now();
  const span = { "1d": 86_400_000, "1w": 7 * 86_400_000, "1m": 30 * 86_400_000 }[range] || 86_400_000;
  const articles = DEMO_TITLES.map((title, i) => ({
    title,
    source: `サンプル${(i % 4) + 1}`,
    link: "",
    publishedAt: now - ((i + 1) / (DEMO_TITLES.length + 1)) * span,
  }));
  const puzzle = buildPuzzle(articles, { range, now, seed: `demo-${range}` });
  if (puzzle) puzzle.demo = true;
  return puzzle;
}

// ---------------------------------------------------------------- 読み込み
async function loadPuzzle(range) {
  state.range = range;
  stopTimer();
  el.veil.hidden = false;
  el.start.hidden = true;
  el.veilTitle.textContent = t("読み込み中…");
  el.veilNote.textContent = t("直近のニュースから盤面を組んでいます。");
  el.board.innerHTML = "";
  el.rack.innerHTML = "";
  el.clues.innerHTML = "";
  el.detail.hidden = true;
  el.result.hidden = true;

  let puzzle = null;
  let reason = "offline";
  try {
    const res = await fetch(`/api/news/puzzle?range=${encodeURIComponent(range)}`);
    const body = await res.json();
    if (res.ok) puzzle = body.puzzle;
    else reason = body.reason || body.error || "error";
  } catch {
    // オフライン・静的ホスティング。下のデモ盤に落ちる
  }
  if (!puzzle) puzzle = demoPuzzle(range);
  if (!puzzle) {
    el.veilTitle.textContent = t("出題を準備中です");
    el.veilNote.textContent = t("見出しが集まると盤面ができます。しばらくしてから開いてください。");
    return;
  }

  setPuzzle(puzzle, reason);
}

// reason: 実ニュースの盤が取れなかったときの理由（デモ盤の説明文に使う）
function setPuzzle(puzzle, reason = "") {
  state.puzzle = puzzle;
  state.demo = !!puzzle.demo;
  state.filled = new Map();
  state.solved = new Set();
  state.picked = -1;
  state.penaltyMs = 0;
  state.finalMs = 0;
  state.mine = null;
  state.submitted = false;
  state.cells = new Map(puzzle.cells.map((c) => [key(c.x, c.y), c]));
  state.rack = puzzle.rack.map((ch) => ({ ch, used: false }));
  for (const c of puzzle.cells) {
    if (c.ch && c.given) state.filled.set(key(c.x, c.y), { ch: c.ch, rackIdx: -1, given: true });
  }

  renderBoard();
  renderRack();
  renderClues();
  renderProgress();
  el.timer.classList.remove("is-penalty");
  showTime(0);

  el.corpus.textContent = state.demo
    ? t("サンプル見出しで作ったデモ盤")
    : `${t("直近")}${t(puzzle.rangeLabel)} / ${puzzle.corpus}${t("本の見出しから")}`;
  el.veilTitle.textContent = `${t("直近")}${t(puzzle.rangeLabel)}${t("の時事クロスワード")}`;
  el.veilNote.textContent = state.demo
    ? demoReason(reason)
    : `${puzzle.entries.length}${t("語。タイムを競います。")}`;
  el.start.hidden = false;
  el.veil.hidden = false;
  localizeDom(document.body);
  loadRanking();
}

// デモ盤に落ちた理由を、そのまま言葉にして出す
function demoReason(reason) {
  if (reason === "news") return t("この構成では時事クロスワードが無効なため、サンプル見出しのデモ盤です。");
  if (reason === "no-articles") return t("まだ見出しが集まっていないため、サンプル見出しのデモ盤です。");
  return t("バックエンドに繋がっていないため、サンプル見出しのデモ盤です。");
}

// ---------------------------------------------------------------- 描画
function renderBoard() {
  const p = state.puzzle;
  el.board.style.setProperty("--cw-cols", p.width);
  el.board.style.gridTemplateColumns = `repeat(${p.width}, var(--cell))`;
  el.board.innerHTML = "";
  for (let y = 0; y < p.height; y++) {
    for (let x = 0; x < p.width; x++) {
      const cell = state.cells.get(key(x, y));
      if (!cell?.ch) {
        const pad = document.createElement("div");
        pad.className = "cw-cell is-void";
        el.board.appendChild(pad);
        continue;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cw-cell";
      btn.dataset.x = x;
      btn.dataset.y = y;
      if (cell.num) {
        const num = document.createElement("span");
        num.className = "cw-num";
        num.textContent = cell.num;
        btn.appendChild(num);
      }
      const ch = document.createElement("span");
      ch.className = "cw-ch";
      btn.appendChild(ch);
      el.board.appendChild(btn);
      paintCell(x, y);
    }
  }
}

const cellEl = (x, y) => el.board.querySelector(`[data-x="${x}"][data-y="${y}"]`);

function paintCell(x, y) {
  const node = cellEl(x, y);
  if (!node) return;
  const placed = state.filled.get(key(x, y));
  node.querySelector(".cw-ch").textContent = placed?.ch ?? "";
  node.classList.toggle("is-given", !!placed?.given);
  node.classList.toggle("is-hinted", !!placed?.hinted);
  node.classList.toggle("is-filled", !!placed && !placed.given);
  node.classList.toggle("is-empty", !placed);
  node.classList.toggle("is-solved", isSolvedCell(x, y));
}

function isSolvedCell(x, y) {
  return state.puzzle.entries.some(
    (e) =>
      state.solved.has(entryId(e)) &&
      cellsOf(e).some((c) => c.x === x && c.y === y)
  );
}

const cellsOf = (e) =>
  Array.from({ length: e.word.length }, (_, i) => ({
    x: e.x + (e.dir === "h" ? i : 0),
    y: e.y + (e.dir === "v" ? i : 0),
    ch: e.word[i],
  }));

function renderRack() {
  el.rack.innerHTML = "";
  state.rack.forEach((tile, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cw-tile";
    btn.dataset.idx = idx;
    btn.textContent = tile.ch;
    btn.classList.toggle("is-used", tile.used);
    btn.classList.toggle("is-picked", state.picked === idx);
    el.rack.appendChild(btn);
  });
}

function renderClues() {
  el.clues.innerHTML = "";
  for (const e of state.puzzle.entries) {
    const li = document.createElement("li");
    li.className = "cw-clue";
    li.dataset.entry = entryId(e);
    li.classList.toggle("is-solved", state.solved.has(entryId(e)));

    const no = document.createElement("span");
    no.className = "cw-clue-no";
    no.textContent = `${e.num}${e.dir === "h" ? t("ヨコ") : t("タテ")}(${e.word.length})`;

    const text = document.createElement("span");
    text.className = "cw-clue-text";
    text.textContent = state.solved.has(entryId(e)) ? e.surface : e.clue;
    if (e.byAi && !state.solved.has(entryId(e))) {
      const tag = document.createElement("span");
      tag.className = "cw-clue-ai";
      tag.textContent = "AI";
      text.appendChild(tag);
    }

    li.append(no, text);
    li.addEventListener("click", () => {
      if (state.solved.has(entryId(e))) showDetail(e);
    });
    el.clues.appendChild(li);
  }
}

function renderProgress() {
  const total = state.puzzle.entries.length;
  el.progress.textContent = `${state.solved.size} / ${total} ${t("語")}`;
}

// ---------------------------------------------------------------- タイム
const fmtTime = (ms) => {
  const total = Math.max(0, ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const d = Math.floor((total % 1000) / 100);
  return { head: `${m}:${String(s).padStart(2, "0")}`, tenth: `.${d}` };
};

function showTime(ms) {
  const { head, tenth } = fmtTime(ms);
  el.timer.textContent = head;
  const small = document.createElement("small");
  small.textContent = tenth;
  el.timer.appendChild(small);
}

const elapsed = () =>
  state.running ? performance.now() - state.startedAt + state.penaltyMs : 0;

function startTimer() {
  state.startedAt = performance.now();
  state.running = true;
  const tick = () => {
    if (!state.running) return;
    showTime(elapsed());
    state.frame = requestAnimationFrame(tick);
  };
  tick();
}

function stopTimer() {
  state.running = false;
  cancelAnimationFrame(state.frame);
}

// ---------------------------------------------------------------- 文字を置く
function lockedAt(x, y) {
  const placed = state.filled.get(key(x, y));
  return !!placed?.given || isSolvedCell(x, y);
}

function pick(idx) {
  state.picked = state.picked === idx ? -1 : idx;
  renderRack();
}

function placeAt(x, y, rackIdx) {
  const cell = state.cells.get(key(x, y));
  if (!cell?.ch || lockedAt(x, y)) return false;
  const tile = state.rack[rackIdx];
  if (!tile || tile.used) return false;

  const prev = state.filled.get(key(x, y));
  if (prev && prev.rackIdx >= 0) state.rack[prev.rackIdx].used = false;

  state.filled.set(key(x, y), { ch: tile.ch, rackIdx, given: false });
  tile.used = true;
  state.picked = -1;
  paintCell(x, y);
  renderRack();
  checkEntries(x, y);
  return true;
}

function takeBack(x, y) {
  if (lockedAt(x, y)) return;
  const placed = state.filled.get(key(x, y));
  if (!placed) return;
  if (placed.rackIdx >= 0) state.rack[placed.rackIdx].used = false;
  state.filled.delete(key(x, y));
  paintCell(x, y);
  renderRack();
}

// 置いたマスを含む語が埋まったかどうかを見る
function checkEntries(x, y) {
  for (const e of state.puzzle.entries) {
    if (state.solved.has(entryId(e))) continue;
    const cells = cellsOf(e);
    if (!cells.some((c) => c.x === x && c.y === y)) continue;
    if (!cells.every((c) => state.filled.has(key(c.x, c.y)))) continue;

    const ok = cells.every((c) => state.filled.get(key(c.x, c.y)).ch === c.ch);
    if (ok) solveEntry(e, cells);
    else flashWrong(cells);
  }
}

function solveEntry(e, cells) {
  state.solved.add(entryId(e));
  for (const c of cells) {
    paintCell(c.x, c.y);
    const node = cellEl(c.x, c.y);
    if (!node) continue;
    node.classList.remove("is-pop");
    void node.offsetWidth; // アニメーションを取り直す
    node.classList.add("is-pop");
  }
  renderClues();
  renderProgress();
  showDetail(e);
  localizeDom(el.detail);
  if (state.solved.size === state.puzzle.entries.length) finish();
}

function flashWrong(cells) {
  for (const c of cells) {
    const node = cellEl(c.x, c.y);
    if (!node) continue;
    node.classList.remove("is-wrong");
    void node.offsetWidth;
    node.classList.add("is-wrong");
    setTimeout(() => node.classList.remove("is-wrong"), 400);
  }
}

// ---------------------------------------------------------------- 正解した語の詳細
const fmtDate = (ms) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
};

// 話題量の推移。棒の高さが本数、いちばん多かった時間帯だけ色を変える
function buzzChart(buzz, range) {
  const w = 300;
  const h = 84;
  const pad = { l: 4, r: 4, t: 10, b: 14 };
  const max = Math.max(1, ...buzz.map((b) => b.n));
  const bw = (w - pad.l - pad.r) / buzz.length;
  const svg = [
    `<svg class="cw-chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${t("話題量の推移")}">`,
  ];
  buzz.forEach((b, i) => {
    const bh = Math.round(((h - pad.t - pad.b) * b.n) / max);
    const x = pad.l + i * bw;
    const y = h - pad.b - bh;
    const cls = b.n === max && b.n > 0 ? "cw-bar cw-bar-peak" : "cw-bar";
    svg.push(
      `<rect class="${cls}" x="${x.toFixed(1)}" y="${y}" width="${Math.max(1, bw - 1.4).toFixed(
        1
      )}" height="${Math.max(b.n ? 1 : 0, bh)}"><title>${fmtDate(b.t)} ${b.n}${t("本")}</title></rect>`
    );
  });
  svg.push(`<line class="cw-axis" x1="0" y1="${h - pad.b}" x2="${w}" y2="${h - pad.b}" />`);
  const label = (ms) => {
    const d = new Date(ms);
    return range === "1d" ? `${d.getHours()}${t("時")}` : `${d.getMonth() + 1}/${d.getDate()}`;
  };
  svg.push(`<text x="0" y="${h - 4}">${label(buzz[0].t)}</text>`);
  svg.push(`<text x="${w}" y="${h - 4}" text-anchor="end">${label(buzz[buzz.length - 1].t)}</text>`);
  svg.push(`<text x="0" y="7">${t("最大")} ${max}${t("本")}</text>`);
  svg.push("</svg>");
  return svg.join("");
}

function showDetail(e) {
  const p = state.puzzle;
  const box = document.createElement("div");

  const word = document.createElement("p");
  word.className = "cw-detail-word";
  word.textContent = e.surface;
  const sub = document.createElement("p");
  sub.className = "cw-detail-sub";
  sub.textContent = `${t("直近")}${t(p.rangeLabel)} / ${e.mentions}${t("本の見出し")} / ${
    e.sources
  }${t("媒体")}`;
  box.append(word, sub);

  if (e.summary) {
    const sum = document.createElement("p");
    sum.className = "cw-detail-summary";
    sum.textContent = e.summary;
    box.appendChild(sum);
  }

  const evTitle = document.createElement("h3");
  evTitle.textContent = t("根拠になった記事 TOP3");
  box.appendChild(evTitle);

  if (e.evidence.length) {
    const list = document.createElement("ol");
    list.className = "cw-evidence";
    e.evidence.forEach((ev, i) => {
      const li = document.createElement("li");
      const rank = document.createElement("span");
      rank.className = "cw-ev-rank";
      rank.textContent = `${i + 1}.`;
      const body = document.createElement("span");
      const a = document.createElement("a");
      a.href = ev.link;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = ev.title;
      const meta = document.createElement("span");
      meta.className = "cw-ev-meta";
      meta.textContent = [ev.source, ev.publishedAt ? fmtDate(ev.publishedAt) : ""]
        .filter(Boolean)
        .join(" ・ ");
      body.append(a, meta);
      li.append(rank, body);
      list.appendChild(li);
    });
    box.appendChild(list);
  } else {
    const none = document.createElement("p");
    none.className = "cw-empty";
    none.textContent = t("デモ盤のため、記事へのリンクはありません。");
    box.appendChild(none);
  }

  const chartTitle = document.createElement("h3");
  chartTitle.textContent = t("どれくらい話題になったか");
  box.appendChild(chartTitle);
  const chart = document.createElement("div");
  chart.innerHTML = buzzChart(e.buzz, p.range);
  box.appendChild(chart);
  const note = document.createElement("p");
  note.className = "cw-chart-note";
  note.textContent = `${t("この語を含む見出しの本数")}（${t(p.rangeLabel)}）`;
  box.appendChild(note);

  el.detailBody.replaceChildren(box);
  el.detail.hidden = false;
}

// ---------------------------------------------------------------- クリアと記録
function solutionText() {
  return state.puzzle.cells
    .slice()
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((c) => (c.ch ? state.filled.get(key(c.x, c.y))?.ch ?? "?" : "."))
    .join("");
}

function finish() {
  state.finalMs = elapsed();
  stopTimer();
  showTime(state.finalMs);
  el.result.hidden = false;
  const { head, tenth } = fmtTime(state.finalMs);
  el.resultTime.textContent = head + tenth;
  el.resultNote.textContent = state.demo
    ? t("デモ盤のタイムは記録されません。")
    : `${t("直近")}${t(state.puzzle.rangeLabel)}${t("の盤")} / ${state.puzzle.entries.length}${t("語")}${
        state.penaltyMs ? ` / ${t("ヒント")}+${state.penaltyMs / 1000}${t("秒")}` : ""
      }`;
  el.resultForm.hidden = state.demo;
}

async function loadRanking() {
  const id = state.puzzle?.id;
  el.ranking.innerHTML = "";
  if (!id) {
    const li = document.createElement("li");
    li.className = "cw-empty";
    li.textContent = t("デモ盤にはランキングがありません。");
    el.ranking.appendChild(li);
    return;
  }
  let scores = [];
  try {
    const res = await fetch(`/api/news/scores?puzzle=${encodeURIComponent(id)}`);
    if (res.ok) scores = (await res.json()).scores ?? [];
  } catch {
    // 取れなければ空のまま
  }
  if (!scores.length) {
    const li = document.createElement("li");
    li.className = "cw-empty";
    li.textContent = t("まだ誰も解いていません。1位を狙えます。");
    el.ranking.appendChild(li);
    return;
  }
  scores.forEach((s, i) => {
    const li = document.createElement("li");
    if (state.mine && s.name === state.mine.name && s.ms === state.mine.ms) li.classList.add("is-me");
    const no = document.createElement("span");
    no.className = "cw-rank-no";
    no.textContent = `${i + 1}.`;
    const name = document.createElement("span");
    name.className = "cw-rank-name";
    name.textContent = s.name;
    const ms = document.createElement("span");
    ms.className = "cw-rank-ms";
    const f = fmtTime(s.ms);
    ms.textContent = f.head + f.tenth;
    li.append(no, name, ms);
    el.ranking.appendChild(li);
  });
}

// ---------------------------------------------------------------- 入力
el.board.addEventListener("click", (ev) => {
  const node = ev.target.closest(".cw-cell");
  if (!node || node.classList.contains("is-void")) return;
  const x = Number(node.dataset.x);
  const y = Number(node.dataset.y);
  if (lockedAt(x, y)) {
    const e = state.puzzle.entries.find(
      (en) => state.solved.has(entryId(en)) && cellsOf(en).some((c) => c.x === x && c.y === y)
    );
    if (e) showDetail(e);
    return;
  }
  if (state.picked >= 0) placeAt(x, y, state.picked);
  else takeBack(x, y);
});

// タイルはタップで選ぶ / ドラッグで直接置く、のどちらでも扱える
let drag = null;

el.rack.addEventListener("pointerdown", (ev) => {
  const tile = ev.target.closest(".cw-tile");
  if (!tile || tile.classList.contains("is-used")) return;
  drag = { idx: Number(tile.dataset.idx), x: ev.clientX, y: ev.clientY, ghost: null, tile };
  tile.setPointerCapture?.(ev.pointerId);
});

document.addEventListener("pointermove", (ev) => {
  if (!drag) return;
  const far = Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) > 6;
  if (!drag.ghost && far) {
    drag.ghost = drag.tile.cloneNode(true);
    drag.ghost.classList.add("cw-ghost");
    drag.ghost.classList.remove("is-picked");
    document.body.appendChild(drag.ghost);
  }
  if (drag.ghost) {
    drag.ghost.style.left = `${ev.clientX}px`;
    drag.ghost.style.top = `${ev.clientY}px`;
    ev.preventDefault();
  }
});

document.addEventListener("pointerup", (ev) => {
  if (!drag) return;
  const { idx, ghost } = drag;
  drag = null;
  if (!ghost) {
    pick(idx); // 動かさなかった＝タップで選んだ
    return;
  }
  ghost.remove();
  const node = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.(".cw-cell");
  if (node && !node.classList.contains("is-void")) {
    placeAt(Number(node.dataset.x), Number(node.dataset.y), idx);
  }
});

document.addEventListener("pointercancel", () => {
  drag?.ghost?.remove();
  drag = null;
});

el.ranges.addEventListener("click", (ev) => {
  const tab = ev.target.closest(".range-tab");
  if (!tab) return;
  for (const b of el.ranges.querySelectorAll(".range-tab")) {
    const on = b === tab;
    b.classList.toggle("is-on", on);
    b.setAttribute("aria-selected", String(on));
  }
  loadPuzzle(tab.dataset.range);
});

el.start.addEventListener("click", () => {
  el.veil.hidden = true;
  startTimer();
});

$("cw-shuffle").addEventListener("click", () => {
  for (let i = state.rack.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [state.rack[i], state.rack[j]] = [state.rack[j], state.rack[i]];
  }
  // 並べ替えで添字がずれるので、盤に置いてある文字との対応を取り直す
  reindexRack();
  state.picked = -1;
  renderRack();
});

// 盤に置いた文字と手持ちの対応を、いまの並び順で取り直す
function reindexRack() {
  for (const tile of state.rack) tile.used = false;
  for (const [, placed] of state.filled) {
    if (placed.given) continue;
    const idx = state.rack.findIndex((tk) => tk.ch === placed.ch && !tk.used);
    placed.rackIdx = idx;
    if (idx >= 0) state.rack[idx].used = true;
  }
}

$("cw-reset").addEventListener("click", () => {
  for (const [k, placed] of [...state.filled]) {
    if (placed.given) continue;
    const [x, y] = k.split(",").map(Number);
    if (isSolvedCell(x, y)) continue;
    state.filled.delete(k);
    paintCell(x, y);
  }
  reindexRack();
  state.picked = -1;
  renderRack();
});

$("cw-hint").addEventListener("click", () => {
  const open = state.puzzle.cells.filter(
    (c) => c.ch && !state.filled.has(key(c.x, c.y)) && !isSolvedCell(c.x, c.y)
  );
  if (!open.length) return;
  const cell = open[Math.floor(Math.random() * open.length)];
  const idx = state.rack.findIndex((tk) => tk.ch === cell.ch && !tk.used);
  if (idx >= 0) state.rack[idx].used = true;
  state.filled.set(key(cell.x, cell.y), { ch: cell.ch, rackIdx: idx, given: false, hinted: true });
  state.penaltyMs += 5000;
  el.timer.classList.add("is-penalty");
  setTimeout(() => el.timer.classList.remove("is-penalty"), 600);
  paintCell(cell.x, cell.y);
  renderRack();
  checkEntries(cell.x, cell.y);
});

$("cw-result-close").addEventListener("click", () => {
  el.result.hidden = true;
});

$("cw-share").addEventListener("click", () => {
  const { head, tenth } = fmtTime(state.finalMs);
  const text = `${t("時事クロスワードを")}${head}${tenth}${t("で解いた")}🧩`;
  const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(
    location.origin + "/crossword"
  )}`;
  window.open(url, "_blank", "noopener");
});

el.resultForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (state.submitted || state.demo || !state.puzzle?.id) return;
  const name = el.name.value.trim();
  try {
    localStorage.setItem("nl_cw_name", name);
  } catch {
    // 保存できなくても登録はできる
  }
  const res = await fetch("/api/news/scores", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      puzzle: state.puzzle.id,
      name,
      ms: Math.round(state.finalMs),
      solution: solutionText(),
    }),
  });
  if (!res.ok) {
    el.resultNote.textContent = t("タイムを登録できませんでした。");
    return;
  }
  const out = await res.json();
  state.submitted = true;
  state.mine = { name: out.name, ms: Math.round(state.finalMs) };
  el.resultNote.textContent = `${out.total}${t("人中")}${out.rank}${t("位")}`;
  el.resultForm.hidden = true;
  loadRanking();
});

// ---------------------------------------------------------------- 起動
try {
  el.name.value = localStorage.getItem("nl_cw_name") || "";
} catch {
  // localStorageが使えない環境でも遊べる
}
if (LANG !== "ja") localizeDom(document.body);
loadPuzzle(new URLSearchParams(location.search).get("range") || "1d");
