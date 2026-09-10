// 見出しの山から、1分で解けるクロスワードを組み立てる。
//
// ここは純関数だけで書いてある（fetchもD1も触らない）ので、
// Worker・ブラウザ・Nodeのどこからでも同じものを読み込める。
// 呼ぶ側は「期間で絞った記事の配列」を渡すだけでよい。
//
// 日本語のクロスワードは、漢字の読みが要るとその時点で辞書が必要になる。
// このリポジトリは依存を増やさない決まりなので、盤に載せるのはカタカナ語だけにした。
// 時事の見出しはカタカナ語（人名・企業名・競技名・製品名）が濃いので、これで十分成立する。

// --- カタカナの正規化 -------------------------------------------------------
// 日本語のクロスワードの慣例に合わせ、小書き文字は大きい字として1マスに置く。
const SMALL_TO_LARGE = {
  ァ: "ア", ィ: "イ", ゥ: "ウ", ェ: "エ", ォ: "オ",
  ッ: "ツ", ャ: "ヤ", ュ: "ユ", ョ: "ヨ", ヮ: "ワ",
};

export const normalizeWord = (s) =>
  String(s).replace(/[ァィゥェォッャュョヮ]/g, (c) => SMALL_TO_LARGE[c]);

// カタカナ（＋長音）の連なり。中黒や記号はここで自然に区切られる
const KATAKANA_RUN = /[ァ-ヺー]{3,12}/g;

// 見出しの飾りに使われるだけで、時事ネタとして面白くない語
const STOPWORDS = new Set([
  "ニュース", "サイト", "ページ", "ネット", "インターネット", "オンライン",
  "ランキング", "インタビュー", "コメント", "シリーズ", "スペシャル",
  "プレゼント", "キャンペーン", "テレビ", "ラジオ", "メディア", "レポート",
  "ポイント", "サービス", "データ", "グループ", "センター", "システム",
  "プロジェクト", "スタート", "チェック", "アップ", "ダウン", "オススメ",
  "トップ", "ランク", "ライブ", "ケース", "タイプ", "ルール", "スタッフ",
  "メンバー", "ファン", "イベント", "ホテル", "ショップ", "セール",
  "アプリ", "サイズ", "カラー", "デザイン", "シーン", "ストーリー",
  "ドキュメント", "コラム", "コーナー", "フォト", "ギャラリー", "ムービー",
]);

const isBoring = (w) =>
  STOPWORDS.has(w) ||
  /^[ー]+$/.test(w) ||
  /^ー/.test(w) ||
  // 「アメリカン」のような語尾だけの断片は避けたいが、ここでは長音の連続だけ弾く
  /ーー/.test(w);

// 見出し1本から、盤に載せられるカタカナ語を拾う（重複は1回に畳む）
export function wordsInTitle(title, { min = 3, max = 7 } = {}) {
  const found = new Map(); // 正規化後 -> 見出し上の表記
  for (const raw of String(title).match(KATAKANA_RUN) || []) {
    const surface = raw.replace(/ー+$/, "");
    const word = normalizeWord(surface);
    if (word.length < min || word.length > max) continue;
    if (isBoring(word)) continue;
    if (!found.has(word)) found.set(word, surface);
  }
  return found;
}

// 見出しの切り出しは何度も要るので、記事1本につき1回だけやって持ち回る。
// 1か月ぶん（数千本）を相手にすると、この一手間の有無がそのままCPU時間になる。
export const withWords = (articles) =>
  articles.map((a) => (a.words ? a : { ...a, words: wordsInTitle(a.title) }));

const wordsOf = (a) => a.words ?? wordsInTitle(a.title);

// --- 話題の採点 -------------------------------------------------------------
// 「何本の見出しに出たか」を土台に、新しいほど・媒体が割れているほど高く見る。
export function rankCandidates(articles, { now = Date.now(), windowMs = 86_400_000 } = {}) {
  const stat = new Map();
  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    const age = Math.max(0, now - (a.publishedAt || 0));
    if (age > windowMs) continue;
    const fresh = 1 + (1 - age / windowMs); // 直近ほど 2.0 に近づく
    for (const [word, surface] of wordsOf(a)) {
      let s = stat.get(word);
      if (!s) {
        s = { word, count: 0, score: 0, sources: new Set(), surfaces: new Map(), articles: [] };
        stat.set(word, s);
      }
      s.count++;
      s.score += fresh;
      if (a.source) s.sources.add(a.source);
      s.surfaces.set(surface, (s.surfaces.get(surface) || 0) + 1);
      s.articles.push(i);
    }
  }
  const out = [];
  for (const s of stat.values()) {
    const surface = [...s.surfaces.entries()].sort((a, b) => b[1] - a[1])[0][0];
    out.push({
      word: s.word,
      surface,
      count: s.count,
      sources: s.sources.size,
      articles: s.articles,
      // 媒体が割れている話題を上に。長すぎる語は盤が組みにくいので軽く割り引く
      score: s.score + Math.min(3, s.sources.size - 1) * 0.8 - Math.max(0, s.word.length - 5) * 0.3,
    });
  }
  return out.sort((a, b) => b.score - a.score || b.count - a.count);
}

// 上位から、互いに包含しない語だけを取る（ワールド と ワールドカップ を同時に出さない）
export function pickWords(ranked, { limit = 7, minCount = 2 } = {}) {
  const pick = (need) => {
    const chosen = [];
    for (const c of ranked) {
      if (c.count < need) continue;
      if (chosen.some((p) => p.word.includes(c.word) || c.word.includes(p.word))) continue;
      chosen.push(c);
      if (chosen.length >= limit) break;
    }
    return chosen;
  };
  let chosen = pick(minCount);
  // 収集を始めた直後は母数が少ない。足りなければ1本だけの語も混ぜる
  if (chosen.length < Math.min(4, limit)) chosen = pick(1);
  return chosen;
}

// --- 盤面を組む -------------------------------------------------------------
// 交差の多さと盤の小ささを見ながら、良い置き場所を1語ずつ選んでいく。
const key = (x, y) => `${x},${y}`;

function canPlace(grid, word, x, y, dir) {
  const dx = dir === "h" ? 1 : 0;
  const dy = dir === "h" ? 0 : 1;
  // 語の前後は空でなければならない（別の語と一直線に繋がってしまう）
  if (grid.has(key(x - dx, y - dy))) return -1;
  if (grid.has(key(x + dx * word.length, y + dy * word.length))) return -1;

  let crossings = 0;
  for (let i = 0; i < word.length; i++) {
    const cx = x + dx * i;
    const cy = y + dy * i;
    const cell = grid.get(key(cx, cy));
    if (cell) {
      // 同じ向きの語が既に通っているマスには重ねられない
      if (cell[dir] != null || cell.ch !== word[i]) return -1;
      crossings++;
    } else {
      // 交差しないマスの真横（真上下）に字があると、意図しない語ができる
      if (grid.has(key(cx + dy, cy + dx))) return -1;
      if (grid.has(key(cx - dy, cy - dx))) return -1;
    }
  }
  return crossings;
}

function commit(grid, entry) {
  const dx = entry.dir === "h" ? 1 : 0;
  const dy = entry.dir === "h" ? 0 : 1;
  for (let i = 0; i < entry.word.length; i++) {
    const k = key(entry.x + dx * i, entry.y + dy * i);
    const cell = grid.get(k) || { ch: entry.word[i], h: null, v: null };
    cell[entry.dir] = entry.id;
    grid.set(k, cell);
  }
}

// 置いてある語すべてに対して、この語の置き場所を総当たりで探す
function bestPlacement(grid, placed, word, maxSize) {
  let best = null;
  for (const p of placed) {
    const pdx = p.dir === "h" ? 1 : 0;
    const pdy = p.dir === "h" ? 0 : 1;
    for (let i = 0; i < p.word.length; i++) {
      for (let j = 0; j < word.length; j++) {
        if (p.word[i] !== word[j]) continue;
        const dir = p.dir === "h" ? "v" : "h";
        const cx = p.x + pdx * i;
        const cy = p.y + pdy * i;
        const x = dir === "h" ? cx - j : cx;
        const y = dir === "h" ? cy : cy - j;
        const crossings = canPlace(grid, word, x, y, dir);
        if (crossings < 1) continue;
        const bb = bounds([...placed, { word, x, y, dir }]);
        if (bb.w > maxSize || bb.h > maxSize) continue;
        // 交差が多く・盤が小さく・正方形に近いものを好む
        const score = crossings * 5 - (bb.w + bb.h) - Math.abs(bb.w - bb.h) * 0.5;
        if (!best || score > best.score) best = { word, x, y, dir, score };
      }
    }
  }
  return best;
}

// 最初の1語を決め打ちで置いてから、置ける語のうち一番良いものを1語ずつ足していく
function growFrom(seed, words, maxSize, maxWords) {
  const grid = new Map();
  const first = { id: 0, word: seed, x: 0, y: 0, dir: "h" };
  commit(grid, first);
  const placed = [first];
  const rest = words.filter((w) => w !== seed);

  while (rest.length && placed.length < maxWords) {
    let best = null;
    for (const word of rest) {
      const cand = bestPlacement(grid, placed, word, maxSize);
      if (cand && (!best || cand.score > best.score)) best = cand;
    }
    if (!best) break; // どの語も交差できなくなったら打ち切る
    const entry = { id: placed.length, word: best.word, x: best.x, y: best.y, dir: best.dir };
    commit(grid, entry);
    placed.push(entry);
    rest.splice(rest.indexOf(best.word), 1);
  }
  return { placed, grid };
}

// words: 盤に載せたい語の配列。交差できない語は静かに捨てる。
// どの語から置き始めるかで結果が変わるので、全部を起点に試して一番良い盤を返す。
export function buildGrid(words, { maxSize = 13, maxWords = 8 } = {}) {
  const list = [...new Set(words)];
  if (!list.length) return { placed: [], grid: new Map() };

  let best = null;
  for (const seed of list) {
    const out = growFrom(seed, list, maxSize, maxWords);
    const bb = bounds(out.placed);
    // 載った語数が最優先。同数なら小さく正方形に近い盤を採る
    const score = out.placed.length * 100 - (bb.w + bb.h) - Math.abs(bb.w - bb.h) * 0.5;
    if (!best || score > best.score) best = { ...out, score };
  }
  return { placed: best.placed, grid: best.grid };
}

function bounds(entries) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of entries) {
    const ex = e.x + (e.dir === "h" ? e.word.length - 1 : 0);
    const ey = e.y + (e.dir === "v" ? e.word.length - 1 : 0);
    x0 = Math.min(x0, e.x); y0 = Math.min(y0, e.y);
    x1 = Math.max(x1, ex); y1 = Math.max(y1, ey);
  }
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// --- 乱数（同じIDからは必ず同じ盤ができる） ---------------------------------
export function rngFrom(seed) {
  let a = 0;
  for (let i = 0; i < String(seed).length; i++) a = (a * 31 + String(seed).charCodeAt(i)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const shuffled = (arr, rnd) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// --- 根拠と話題量 -----------------------------------------------------------
const mentions = (article, word) => wordsOf(article).has(word);

// 正解した語の裏取り。同じ媒体ばかりにならないよう、媒体は1本ずつ拾う
export function pickEvidence(articles, word, { limit = 3 } = {}) {
  const hits = articles
    .filter((a) => a.link && mentions(a, word))
    .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
  const out = [];
  const seenSource = new Set();
  const seenTitle = new Set();
  for (const pass of [1, 2]) {
    for (const a of hits) {
      if (out.length >= limit) break;
      if (seenTitle.has(a.title)) continue;
      if (pass === 1 && a.source && seenSource.has(a.source)) continue;
      out.push({
        title: a.title,
        source: a.source || "",
        link: a.link,
        publishedAt: a.publishedAt || 0,
      });
      seenTitle.add(a.title);
      if (a.source) seenSource.add(a.source);
    }
  }
  return out;
}

// どれくらい話題になったかの推移。1日なら1時間刻み、1週間/1か月なら1日刻み
export function buzzSeries(articles, word, { now = Date.now(), windowMs, buckets = 24 } = {}) {
  const step = windowMs / buckets;
  const series = Array.from({ length: buckets }, (_, i) => ({
    t: Math.round(now - windowMs + step * (i + 1)),
    n: 0,
  }));
  for (const a of articles) {
    const age = now - (a.publishedAt || 0);
    if (age < 0 || age > windowMs) continue;
    if (!mentions(a, word)) continue;
    const idx = Math.min(buckets - 1, Math.floor((windowMs - age) / step));
    series[idx].n++;
  }
  return series;
}

// AIが使えないときのヒント。語を伏せた見出しをそのまま出題文にする
export function maskedClue(articles, word, surface) {
  const hits = articles.filter((a) => mentions(a, word));
  if (!hits.length) return `${word.length}文字のカタカナ語`;
  // 短い見出しほど問題文として読みやすい
  const title = hits.sort((a, b) => a.title.length - b.title.length)[0].title;
  const mask = "〇".repeat(word.length);
  const masked = title
    .replace(new RegExp(escapeRe(surface), "g"), mask)
    .replace(new RegExp(escapeRe(word), "g"), mask);
  return masked.includes(mask) ? masked : `${title}（${word.length}文字）`;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// --- 出題データ一式 ---------------------------------------------------------
export const RANGES = {
  "1d": { windowMs: 86_400_000, buckets: 24, label: "24時間" },
  "1w": { windowMs: 7 * 86_400_000, buckets: 7, label: "1週間" },
  "1m": { windowMs: 30 * 86_400_000, buckets: 30, label: "1か月" },
};

// 交差マスを優先して何マスかを最初から埋めておく（1分で解ける難度にするため）
function pickGivens(cells, entries, rnd, ratio) {
  const crossKeys = new Set();
  const seen = new Set();
  for (const e of entries) {
    for (let i = 0; i < e.word.length; i++) {
      const k = key(e.x + (e.dir === "h" ? i : 0), e.y + (e.dir === "v" ? i : 0));
      if (seen.has(k)) crossKeys.add(k);
      seen.add(k);
    }
  }
  const all = cells.filter((c) => c.ch);
  const cross = shuffled(all.filter((c) => crossKeys.has(key(c.x, c.y))), rnd);
  const rest = shuffled(all.filter((c) => !crossKeys.has(key(c.x, c.y))), rnd);
  const want = Math.max(1, Math.round(all.length * ratio));
  return new Set([...cross, ...rest].slice(0, want).map((c) => key(c.x, c.y)));
}

// おじゃまタイル。あり過ぎると1分で終わらないので少しだけ混ぜる
const DECOY_POOL = [..."アイウエオカキクサシスタチツナニハヒフヘホマミムメモヤユヨラリルレロワンー"];

/**
 * 記事の配列から、そのまま画面に出せる出題データを作る。
 * 返す形はクライアントとD1のキャッシュで共用する。
 */
export function buildPuzzle(articles, { range = "1d", now = Date.now(), seed = "", limit = 10, maxWords = 7 } = {}) {
  const conf = RANGES[range] || RANGES["1d"];
  const inWindow = withWords(
    articles.filter((a) => {
      const age = now - (a.publishedAt || 0);
      return age >= 0 && age <= conf.windowMs;
    })
  );
  const ranked = rankCandidates(inWindow, { now, windowMs: conf.windowMs });
  const chosen = pickWords(ranked, { limit });
  if (chosen.length < 3) return null;

  const { placed } = buildGrid(chosen.map((c) => c.word), { maxWords });
  const byWord = new Map(chosen.map((c) => [c.word, c]));
  const bb = bounds(placed);

  const entries = placed
    .map((p) => ({ ...p, x: p.x - bb.x0, y: p.y - bb.y0 }))
    .sort((a, b) => a.y - b.y || a.x - b.x || (a.dir === "h" ? -1 : 1));

  // 交差点の字を1マスずつ並べたもの（盤の解答そのもの）
  const cellMap = new Map();
  for (const e of entries) {
    for (let i = 0; i < e.word.length; i++) {
      cellMap.set(key(e.x + (e.dir === "h" ? i : 0), e.y + (e.dir === "v" ? i : 0)), e.word[i]);
    }
  }
  const cells = [];
  for (let y = 0; y < bb.h; y++) {
    for (let x = 0; x < bb.w; x++) {
      cells.push({ x, y, ch: cellMap.get(key(x, y)) || null });
    }
  }

  // クロスワードの慣例どおり、左上から順に番号を振る
  const nums = new Map();
  let num = 0;
  for (const c of cells) {
    if (!c.ch) continue;
    const startsHere = entries.some((e) => e.x === c.x && e.y === c.y);
    if (startsHere) nums.set(key(c.x, c.y), ++num);
  }

  const rnd = rngFrom(seed || `${range}-${entries.map((e) => e.word).join("")}`);
  const givens = pickGivens(cells, entries, rnd, 0.22);

  const blanks = cells.filter((c) => c.ch && !givens.has(key(c.x, c.y)));
  const decoys = shuffled(DECOY_POOL, rnd).slice(0, Math.min(4, Math.max(2, Math.round(blanks.length * 0.15))));
  const rack = shuffled([...blanks.map((c) => c.ch), ...decoys], rnd);

  return {
    range,
    rangeLabel: conf.label,
    createdAt: now,
    corpus: inWindow.length,
    width: bb.w,
    height: bb.h,
    // 解答は伏せ字にせずそのまま返す。順位はタイムを競う遊びで、賞金は出ない
    cells: cells.map((c) => ({
      x: c.x,
      y: c.y,
      ch: c.ch,
      given: c.ch ? givens.has(key(c.x, c.y)) : false,
      num: nums.get(key(c.x, c.y)) || 0,
    })),
    rack,
    entries: entries.map((e) => {
      const cand = byWord.get(e.word);
      const hits = inWindow.filter((a) => mentions(a, e.word));
      return {
        num: nums.get(key(e.x, e.y)) || 0,
        x: e.x,
        y: e.y,
        dir: e.dir,
        word: e.word,
        surface: cand?.surface || e.word,
        clue: maskedClue(inWindow, e.word, cand?.surface || e.word),
        // AIが使える構成では、あとから要約を差し込む
        summary: "",
        mentions: hits.length,
        sources: cand?.sources || 0,
        evidence: pickEvidence(inWindow, e.word),
        buzz: buzzSeries(inWindow, e.word, { now, windowMs: conf.windowMs, buckets: conf.buckets }),
      };
    }),
  };
}

// 採点用に、盤の解答を1本の文字列にする
export const solutionString = (puzzle) =>
  puzzle.cells
    .slice()
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((c) => c.ch || ".")
    .join("");
