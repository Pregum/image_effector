// 時事クロスワードのサーバ側。
//
// 流れは3段:
//   1. cron（1時間ごと）で各社のRSSを取り、見出しだけをD1に貯める
//   2. 期間（1日/1週間/1か月）ごとに盤面を組み、期間に応じた時間だけキャッシュする
//   3. 解けた人のタイムをランキングに積む
//
// 出題データはキャッシュに載るので、AIを呼ぶのは1日あたり数回で済む。
// AIが無い構成（AI_PROVIDER=none / ローカル）でも、ヒントは見出しの伏せ字で成立する。

import { buildPuzzle, RANGES, solutionString } from "../public/crossword-core.js";
import { articleId, feedList, fetchFeed } from "./news.js";
import { extractJson } from "./json.js";

export const newsEnabled = (env) => !!env.DB;

// 期間ごとの出題の寿命。短い期間ほど早く入れ替える
const PUZZLE_TTL = {
  "1d": 3 * 3_600_000,
  "1w": 12 * 3_600_000,
  "1m": 24 * 3_600_000,
};

// 見出しを残す期間。1か月ぶんの出題に少し余裕を足したところで打ち切る
const KEEP_MS = 35 * 86_400_000;
// 盤を組むのに読む見出しの本数。cronは多めに、リクエスト中の組み直しは少なめに読む
// （無料枠のWorkerはリクエストあたりのCPU時間が短いので、待たせる側を軽くしておく）
const CORPUS_CRON = 3000;
const CORPUS_REQUEST = 1200;

const json = (obj, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": cache },
  });

async function sha256Hex(text) {
  const buf = new TextEncoder().encode(text);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- 収集 -------------------------------------------------------------------
export async function collectNews(env, { now = Date.now() } = {}) {
  const feeds = feedList(env);
  const results = await Promise.all(feeds.map((url) => fetchFeed(url, { now })));
  const items = results.flat();

  // 同じ見出しが複数のフィードに出るので、ここで1本に畳んでから書き込む
  const byId = new Map();
  for (const it of items) {
    const id = await articleId(it.title, it.source);
    const prev = byId.get(id);
    // 同じ話題なら、リンクを持っている方・新しい方を残す
    if (!prev || (!prev.link && it.link) || it.publishedAt > prev.publishedAt) {
      byId.set(id, { ...it, id });
    }
  }

  const rows = [...byId.values()];
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO news_articles (id, title, source, link, published_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
    await env.DB.batch(
      chunk.map((r) => stmt.bind(r.id, r.title, r.source, r.link, r.publishedAt, now))
    );
  }

  // 古い見出しと、寿命の切れた出題を捨てる（無料枠の行数を食い潰さないため）
  await env.DB.batch([
    env.DB.prepare("DELETE FROM news_articles WHERE published_at < ?").bind(now - KEEP_MS),
    env.DB.prepare("DELETE FROM crossword_puzzles WHERE created_at < ?").bind(now - 7 * 86_400_000),
    env.DB.prepare("DELETE FROM crossword_scores WHERE created_at < ?").bind(now - 14 * 86_400_000),
  ]);

  return { feeds: feeds.length, fetched: items.length, stored: rows.length };
}

async function loadArticles(env, windowMs, now, limit) {
  const { results } = await env.DB.prepare(
    `SELECT title, source, link, published_at AS publishedAt
       FROM news_articles
      WHERE published_at >= ?
      ORDER BY published_at DESC
      LIMIT ?`
  )
    .bind(now - windowMs, limit)
    .all();
  return results ?? [];
}

// --- AIによるヒントと解説 ---------------------------------------------------
// 出題データはキャッシュされるので、この呼び出しは期間ごとに数時間に1回しか起きない。
const HINT_SYSTEM = `あなたは日本語のクロスワードの出題者です。
与えられた「答えの語」と、その語が出てきた最近のニュース見出しから、
出題文（hint）と、正解者に見せる解説（summary）を作ってください。

守ること:
- hint には答えの語そのもの（カタカナ表記・英語表記・その一部）を絶対に書かない
- hint は25文字以内。「〜な国」「〜の会社」のように、答えを言わずに指し示す
- summary は60文字以内。見出しから読み取れる事実だけを書き、推測は書かない
- 出力は次の形のJSON配列だけ。前置きも説明も付けない
[{"word":"（答えの語）","hint":"（出題文）","summary":"（解説）"}]`;

async function enrichWithAi(puzzle, { ai, spend }) {
  if (!ai) return puzzle;
  const budget = await spend();
  if (!budget.ok) return puzzle;

  const brief = puzzle.entries
    .map((e) => {
      const heads = e.evidence.map((v) => `  - ${v.title}`).join("\n");
      return `語: ${e.surface}\n見出し:\n${heads || "  - （見出しなし）"}`;
    })
    .join("\n\n");

  let parsed = null;
  try {
    const raw = await ai.chat({
      system: HINT_SYSTEM,
      user: `期間: 直近${puzzle.rangeLabel}\n\n${brief}`,
      maxTokens: 700,
      small: true,
    });
    parsed = raw && typeof raw === "object" ? raw : extractJson(String(raw ?? ""));
  } catch {
    return puzzle; // AIが落ちていても伏せ字ヒントで遊べる
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [];

  for (const item of list) {
    const word = String(item?.word ?? "");
    const entry = puzzle.entries.find((e) => e.surface === word || e.word === word);
    if (!entry) continue;
    const hint = String(item?.hint ?? "").trim().slice(0, 60);
    const summary = String(item?.summary ?? "").trim().slice(0, 140);
    // 答えが漏れているヒントは採用しない（伏せ字のヒントのまま残す）
    if (hint && !hint.includes(entry.surface) && !hint.includes(entry.word)) {
      entry.clue = hint;
      entry.byAi = true;
    }
    if (summary) entry.summary = summary;
  }
  return puzzle;
}

// --- 出題 -------------------------------------------------------------------
const bucketOf = (range, now) => Math.floor(now / (PUZZLE_TTL[range] || PUZZLE_TTL["1d"]));

async function readCached(env, id) {
  const row = await env.DB.prepare(
    "SELECT payload FROM crossword_puzzles WHERE id = ?"
  ).bind(id).first();
  if (!row) return null;
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

/**
 * 期間ぶんの出題を返す。同じ期間・同じ時間帯なら、何度呼んでも同じ盤が返る。
 * 見出しが足りずに盤が組めなかったときだけ null を返す。
 */
export async function ensurePuzzle(
  env,
  { ai, spend, range, now = Date.now(), force = false, corpus = CORPUS_REQUEST }
) {
  const conf = RANGES[range] ? range : "1d";
  const id = `${conf}-${bucketOf(conf, now)}`;
  if (!force) {
    const cached = await readCached(env, id);
    if (cached) return cached;
  }

  const articles = await loadArticles(env, RANGES[conf].windowMs, now, corpus);
  const built = buildPuzzle(articles, { range: conf, now, seed: id });
  if (!built) return null;

  const puzzle = await enrichWithAi(built, { ai, spend });
  puzzle.id = id;
  const hash = await sha256Hex(solutionString(puzzle));

  await env.DB.prepare(
    `INSERT INTO crossword_puzzles (id, range_key, created_at, payload, solution_hash)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET payload = excluded.payload,
                                   created_at = excluded.created_at,
                                   solution_hash = excluded.solution_hash`
  )
    .bind(id, conf, now, JSON.stringify(puzzle), hash)
    .run();

  return puzzle;
}

export async function puzzleRoute(req, env, { ai, spend }) {
  const url = new URL(req.url);
  const range = url.searchParams.get("range") || "1d";
  if (!RANGES[range]) return json({ error: "unknown range" }, 400);

  const puzzle = await ensurePuzzle(env, { ai, spend, range });
  if (!puzzle) {
    return json({ error: "not ready", reason: "no-articles", range }, 503);
  }
  // 出題の寿命が尽きるまではCDNに預けてよい（誰が見ても同じ盤なので）
  return json({ puzzle }, 200, "public, max-age=300");
}

// --- ランキング -------------------------------------------------------------
const MAX_NAME = 12;
const cleanName = (v) =>
  String(v ?? "")
    .replace(/[\p{C}]/gu, "")
    .trim()
    .slice(0, MAX_NAME) || "ななし";

export async function scoresRoute(req, env) {
  const url = new URL(req.url);
  const puzzleId = url.searchParams.get("puzzle") || "";
  if (!/^(1d|1w|1m)-\d{1,12}$/.test(puzzleId)) return json({ error: "bad puzzle" }, 400);
  const { results } = await env.DB.prepare(
    `SELECT name, ms, created_at AS createdAt
       FROM crossword_scores
      WHERE puzzle_id = ?
      ORDER BY ms ASC
      LIMIT 20`
  ).bind(puzzleId).all();
  return json({ scores: results ?? [] });
}

/**
 * タイムを記録する。盤の答えのハッシュが合ったものだけ受け付ける
 * （順位はタイムを競うお遊びなので、これ以上の防御はしない）。
 */
export async function submitScoreRoute(req, env, { rateLimit, ip }) {
  if (!(await rateLimit(env, `${ip}#cw`, 20))) return json({ error: "rate limited" }, 429);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const puzzleId = String(body?.puzzle ?? "");
  if (!/^(1d|1w|1m)-\d{1,12}$/.test(puzzleId)) return json({ error: "bad puzzle" }, 400);

  const ms = Math.round(Number(body?.ms));
  if (!Number.isFinite(ms) || ms < 3000 || ms > 3_600_000) {
    return json({ error: "bad time" }, 400);
  }

  const row = await env.DB.prepare(
    "SELECT solution_hash AS hash FROM crossword_puzzles WHERE id = ?"
  ).bind(puzzleId).first();
  if (!row) return json({ error: "unknown puzzle" }, 404);
  if ((await sha256Hex(String(body?.solution ?? ""))) !== row.hash) {
    return json({ error: "not solved" }, 400);
  }

  const name = cleanName(body?.name);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO crossword_scores (id, puzzle_id, name, ms, created_at) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(crypto.randomUUID(), puzzleId, name, ms, now)
    .run();

  const better = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM crossword_scores WHERE puzzle_id = ? AND ms < ?"
  ).bind(puzzleId, ms).first();
  const total = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM crossword_scores WHERE puzzle_id = ?"
  ).bind(puzzleId).first();

  return json({ rank: (better?.n ?? 0) + 1, total: total?.n ?? 1, name });
}

// cronから呼ぶ。収集して、そのまま各期間の盤も温めておく。
// ここでは force しない: 出題は寿命が来たときだけ入れ替える
// （遊んでいる最中に盤が変わると、そのタイムを記録できなくなる）。
export async function refreshAll(env, { ai, spend, now = Date.now() } = {}) {
  const stats = await collectNews(env, { now });
  const built = {};
  for (const range of Object.keys(RANGES)) {
    try {
      const p = await ensurePuzzle(env, { ai, spend, range, now, corpus: CORPUS_CRON });
      built[range] = p ? p.entries.length : 0;
    } catch (err) {
      built[range] = `error: ${String(err).slice(0, 120)}`;
    }
  }
  return { ...stats, built };
}
