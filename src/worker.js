import { DurableObject } from "cloudflare:workers";
import { getAiProvider } from "./ai.js";

const WINDOW_MS = 60_000; // レート制限ウィンドウ幅

// キー（IP等）ごとに1インスタンス割り当てて固定ウィンドウでカウントする
export class RateLimiter extends DurableObject {
  async check(limit = 5) {
    const now = Date.now();
    let w = (await this.ctx.storage.get("w")) ?? null;
    if (!w || now - w.start >= WINDOW_MS) w = { start: now, count: 0 };
    w.count++;
    await this.ctx.storage.put("w", w);
    return w.count <= limit;
  }

  // 日次のAI予算を消費する（UTC日で自動リセット。Cloudflareの無料枠リセットと同じ区切り）
  async spendDaily(cost, cap) {
    const day = Math.floor(Date.now() / 86_400_000);
    let b = (await this.ctx.storage.get("b")) ?? null;
    if (!b || b.day !== day) b = { day, used: 0 };
    if (b.used + cost > cap) return { ok: false, used: b.used, cap };
    b.used += cost;
    await this.ctx.storage.put("b", b);
    return { ok: true, used: b.used, cap };
  }
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });

const clientIp = (req) => req.headers.get("cf-connecting-ip") || "unknown";

async function rateLimit(env, key, limit) {
  // Durable Objectsを繋いでいない構成でも動くようにする
  if (!env.LIMITER) return true;
  try {
    return await env.LIMITER.get(env.LIMITER.idFromName(key)).check(limit);
  } catch {
    return true;
  }
}

// ギャラリー機能が構成されているか（DB・R2・キーが揃っているか）
const galleryEnabled = (env) => !!(env.DB && env.IMAGES && env.GALLERY_KEY);
const disabled = (what) => json({ error: "disabled", reason: what }, 503);

function authed(req, env) {
  if (!env.GALLERY_KEY) return false;
  return req.headers.get("x-gallery-key") === env.GALLERY_KEY;
}

// --- 画像URLの署名 ---
// <img>はヘッダを送れないため、キーの代わりに期限付き署名をクエリに載せる。
// 署名鍵はGALLERY_KEYそのものではなく派生鍵（用途を分離する）。
const IMG_SIG_TTL_MS = 6 * 60 * 60 * 1000;
let signKeyPromise = null;

function getSignKey(env) {
  if (!signKeyPromise) {
    signKeyPromise = (async () => {
      const enc = new TextEncoder();
      const base = await crypto.subtle.importKey(
        "raw", enc.encode(env.GALLERY_KEY || "no-key"),
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
      );
      const derived = await crypto.subtle.sign("HMAC", base, enc.encode("img-sign-v1"));
      return crypto.subtle.importKey(
        "raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
      );
    })();
  }
  return signKeyPromise;
}

async function signImage(env, id, exp) {
  const key = await getSignKey(env);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}:${exp}`));
  return [...new Uint8Array(mac)].slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyImageSig(env, id, exp, sig) {
  const e = Number(exp);
  if (!Number.isFinite(e) || e < Date.now()) return false;
  const expect = await signImage(env, id, exp);
  if (typeof sig !== "string" || sig.length !== expect.length) return false;
  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

// --- AI予算ガード ---
// Workers AIの無料枠は10,000ニューロン/日。その手前(80%)で自分から止めることで、
// 万一アカウントが有料プランだったとしても従量課金の領域に入らない。
const DEFAULT_AI_DAILY_CAP = 8000;
const aiDailyCap = (env) => Number(env.AI_DAILY_CAP) || DEFAULT_AI_DAILY_CAP;
// 1呼び出しあたりのニューロン概算（公式の単価表からの見積り。安全側に多め)
const AI_COST = {
  image: 120,   // flux-1-schnell 1024x1024 / 6ステップ
  caption: 80,  // llava-1.5-7b
  embed: 10,    // bge-m3
  llm70b: 200,  // llama-3.3-70b
  llm8b: 30,    // llama-3.1-8b
};

async function spendAiBudget(env, cost) {
  const cap = aiDailyCap(env);
  try {
    const stub = env.LIMITER.get(env.LIMITER.idFromName("ai-budget-global"));
    return await stub.spendDaily(cost, cap);
  } catch {
    // 予算カウンタが無い/落ちている場合は通す（機能停止より継続を優先）
    return { ok: true, used: 0, cap };
  }
}

const budgetExceeded = () =>
  json({ error: "quota exceeded", reason: "daily-ai-budget" }, 503);

// 日本語などの非ASCIIプロンプトを画像モデル向けに英訳する（失敗時は原文のまま）
async function translatePrompt(ai, p) {
  if (!/[^\x00-\x7F]/.test(p)) return p;
  try {
    const tr = await ai.chat({
      system:
        "Translate the user's image description into a concise English prompt for an image generation model. Reply with the prompt only, no quotes.",
      user: p,
      small: true,
    });
    return String(tr ?? "").trim() || p;
  } catch {
    return p;
  }
}

// NOTE: img2img は2026-08時点で見送り。実地検証の結果:
//  - @cf/runwayml/stable-diffusion-v1-5-img2img → 3040(容量超過)が恒常化
//  - @cf/lykon/dreamshaper-8-lcm → 入力スキーマ(バイト配列)とバックエンド期待(shape[1])が不整合で破損
//  - @cf/bytedance/stable-diffusion-xl-lightning → imageテンソル自体が非対応
//  - FLUX.2 klein系 → ドル課金のPartnerモデルのため不採用（ニューロン枠外）
// 無料枠内で使えるimg2imgモデルが復活したら再実装する。

async function handleGenerate(req, env, ai) {
  if (!(await rateLimit(env, clientIp(req), 5))) {
    return json({ error: "rate limited" }, 429);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const prompt = body?.prompt;
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 500) {
    return json({ error: "invalid prompt" }, 400);
  }

  if (!(await spendAiBudget(env, AI_COST.image + AI_COST.llm8b)).ok) return budgetExceeded();

  const p = await translatePrompt(ai, prompt.trim());

  try {
    const out = await ai.image({ prompt: p, steps: 6 });
    return new Response(out.bytes, {
      headers: { "content-type": out.contentType, "cache-control": "no-store" },
    });
  } catch (e) {
    const msg = e?.message ?? String(e);
    console.error("generation failed:", msg);
    // Workers AI 無料枠(ニューロン)の使い切りは専用のステータスで返す
    if (msg.includes("4006") || msg.includes("neurons")) {
      return json({ error: "quota exceeded" }, 503);
    }
    return json({ error: "generation failed" }, 500);
  }
}

const MAX_BLOB = 8 * 1024 * 1024; // 1ファイル上限 8MB

async function saveWork(req, env, ctx, ai) {
  if (!authed(req, env)) return json({ error: "unauthorized" }, 401);
  if (!(await rateLimit(env, clientIp(req) + "#gallery", 10))) {
    return json({ error: "rate limited" }, 429);
  }

  let form;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "invalid form" }, 400);
  }
  const source = form.get("source");
  const thumb = form.get("thumb");
  const metaRaw = form.get("meta");
  if (!(source instanceof File) || !(thumb instanceof File) || typeof metaRaw !== "string") {
    return json({ error: "missing fields" }, 400);
  }
  if (source.size > MAX_BLOB || thumb.size > MAX_BLOB) {
    return json({ error: "file too large" }, 413);
  }
  let meta;
  try {
    meta = JSON.parse(metaRaw);
  } catch {
    return json({ error: "invalid meta" }, 400);
  }
  const recipe = meta?.recipe;
  const width = Number(meta?.width) | 0;
  const height = Number(meta?.height) | 0;
  if (!recipe || width <= 0 || height <= 0) return json({ error: "invalid meta" }, 400);

  const UUID_RE = /^[0-9a-f-]{36}$/;
  let parentA = null;
  let parentB = null;
  if (Array.isArray(meta.parents)) {
    if (typeof meta.parents[0] === "string" && UUID_RE.test(meta.parents[0])) parentA = meta.parents[0];
    if (typeof meta.parents[1] === "string" && UUID_RE.test(meta.parents[1])) parentB = meta.parents[1];
  }

  const id = crypto.randomUUID();
  const sourceType = source.type || "image/webp";
  const thumbType = thumb.type || "image/webp";

  await env.IMAGES.put(`works/${id}/source`, source.stream(), {
    httpMetadata: { contentType: sourceType },
  });
  await env.IMAGES.put(`works/${id}/thumb`, thumb.stream(), {
    httpMetadata: { contentType: thumbType },
  });
  await env.DB.prepare(
    `INSERT INTO works (id, created_at, prompt, recipe, width, height, source_type, thumb_type, parent_a, parent_b)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      Date.now(),
      typeof meta.prompt === "string" ? meta.prompt.slice(0, 500) : null,
      JSON.stringify(recipe),
      width,
      height,
      sourceType,
      thumbType,
      parentA,
      parentB
    )
    .run();

  // 埋め込みはレスポンスを待たせずバックグラウンドで計算する
  ctx.waitUntil(
    computeEmbedding(env, ai, id).catch((e) =>
      console.error("bg embed failed:", e?.message ?? e)
    )
  );

  return json({ id });
}

async function listWorks(req, env) {
  if (!authed(req, env)) return json({ error: "unauthorized" }, 401);
  const { results } = await env.DB.prepare(
    `SELECT id, created_at, prompt, recipe, width, height, caption, embedding, parent_a, parent_b, shared
     FROM works ORDER BY created_at DESC LIMIT 200`
  ).all();
  // <img>用の期限付き署名を作品ごとに添える
  const exp = String(Date.now() + IMG_SIG_TTL_MS);
  const works = await Promise.all(
    results.map(async (r) => {
      let recipe = null;
      let embedding = null;
      try { recipe = JSON.parse(r.recipe); } catch { /* 壊れた行でも一覧は返す */ }
      try { embedding = r.embedding ? JSON.parse(r.embedding) : null; } catch {}
      return {
        id: r.id,
        created_at: r.created_at,
        prompt: r.prompt,
        width: r.width,
        height: r.height,
        caption: r.caption,
        parent_a: r.parent_a,
        parent_b: r.parent_b,
        shared_until: Number(r.shared) || 0,
        sig: await signImage(env, r.id, exp),
        recipe,
        embedding,
      };
    })
  );
  return json({ works, imgExp: exp });
}

// 画像は既定で非公開。所有者は署名付きURL(またはキー)で、
// 共有中の作品だけが期限内に限り誰でも見られる。
async function getWorkImage(req, env, url, id, kind) {
  const priv = { "cache-control": "private, no-store" };
  let cache = priv["cache-control"];
  let allowed = false;

  const sig = url.searchParams.get("s");
  const exp = url.searchParams.get("e");
  if (sig && exp && (await verifyImageSig(env, id, exp, sig))) {
    allowed = true;
  } else if (authed(req, env)) {
    allowed = true;
  } else {
    // 共有中かどうかはDBを引く（署名がある通常利用ではここまで来ない）
    const row = await env.DB.prepare("SELECT shared FROM works WHERE id = ?").bind(id).first();
    const until = Number(row?.shared) || 0;
    const remain = Math.floor((until - Date.now()) / 1000);
    if (remain > 0) {
      allowed = true;
      // 共有期限を超えてキャッシュに残らないようにする
      cache = `public, max-age=${Math.min(remain, 3600)}`;
    }
  }

  if (!allowed) return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json", ...priv },
  });

  const obj = await env.IMAGES.get(`works/${id}/${kind}`);
  if (!obj) return new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: { "content-type": "application/json", ...priv },
  });
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType || "image/webp",
      "cache-control": cache,
    },
  });
}

// --- 共有（作品ごと・24時間で自動失効）---
const SHARE_TTL_MS = 24 * 60 * 60 * 1000;

async function shareWork(req, env, id) {
  if (!authed(req, env)) return json({ error: "unauthorized" }, 401);
  let body = {};
  try { body = await req.json(); } catch { /* 省略時はONとみなす */ }
  const until = body?.on === false ? 0 : Date.now() + SHARE_TTL_MS;
  const r = await env.DB.prepare("UPDATE works SET shared = ? WHERE id = ?").bind(until, id).run();
  if (!r.meta?.changes) return json({ error: "not found" }, 404);
  return json({ shared_until: until });
}

// 共有中の作品のレシピ等（エディタで開くために使う。共有期限内のみ公開）
async function sharedMeta(env, id) {
  const row = await env.DB.prepare(
    "SELECT recipe, width, height, prompt, shared FROM works WHERE id = ?"
  ).bind(id).first();
  const until = Number(row?.shared) || 0;
  if (!row || until <= Date.now()) return null;
  let recipe = null;
  try { recipe = JSON.parse(row.recipe); } catch {}
  return {
    recipe,
    width: row.width,
    height: row.height,
    prompt: row.prompt,
    shared_until: until,
  };
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function sharePage(id, meta, origin) {
  const noStore = { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" };
  if (!meta) {
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>共有リンクの期限切れ — NOIZ LAB</title>` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<style>body{background:#0b0d0c;color:#e8e6df;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center;line-height:1.9}a{color:#c8ff00}</style>` +
      `<div><h1 style="font-size:20px">この共有リンクは期限切れです</h1>` +
      `<p style="color:#8b917e;font-size:14px">共有リンクは作成から約1日で自動的に無効になります。<br>` +
      `もう一度見るには、共有した人にリンクを作り直してもらってください。</p>` +
      `<p><a href="${esc(origin)}/">NOIZ LAB を開く</a></p></div>`,
      { status: 410, headers: noStore }
    );
  }
  // captionはLLaVA生成の内部データなので公開ページには出さない
  const title = meta.prompt || "NOIZ LAB の作品";
  const img = `${origin}/api/works/${id}/thumb`;
  const remainH = Math.max(1, Math.round((meta.shared_until - Date.now()) / 3600000));
  return new Response(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)} — NOIZ LAB</title>` +
    `<meta property="og:title" content="${esc(title)}">` +
    `<meta property="og:description" content="NOIZ LAB で作った画像。リンクは約1日で失効します。">` +
    `<meta property="og:image" content="${esc(img)}">` +
    `<meta property="og:type" content="website">` +
    `<meta name="twitter:card" content="summary_large_image">` +
    `<link rel="preconnect" href="https://fonts.googleapis.com">` +
    `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DotGothic16&family=Zen+Kaku+Gothic+New:wght@400;500&display=swap">` +
    `<style>` +
    `*{box-sizing:border-box;margin:0}` +
    `body{background:radial-gradient(900px 500px at 70% -10%,#1a2012,transparent 60%),#0b0d0c;color:#e8e6df;` +
    `font-family:"Zen Kaku Gothic New",system-ui,sans-serif;line-height:1.85;min-height:100vh;padding:32px 20px 64px}` +
    `main{max-width:760px;margin:0 auto}` +
    `.logo{font-family:"DotGothic16",monospace;font-size:20px;letter-spacing:2px;color:#c8ff00;text-decoration:none}` +
    `h1{font-size:19px;font-weight:500;margin:22px 0 14px;line-height:1.6}` +
    `img{width:100%;height:auto;display:block;border:1px solid #3d4433;background:#000;` +
    `box-shadow:0 0 40px rgba(200,255,0,.07),0 24px 60px rgba(0,0,0,.55)}` +
    `.meta{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-top:18px;font-size:12.5px;color:#8b917e}` +
    `.btn{font-family:"DotGothic16",monospace;font-size:13px;letter-spacing:1px;background:#c8ff00;color:#0b0d0c;` +
    `padding:9px 18px;text-decoration:none;display:inline-block;` +
    `clip-path:polygon(0 0,calc(100% - 8px) 0,100% 8px,100% 100%,8px 100%,0 calc(100% - 8px))}` +
    `.expiry{border:1px dashed #3d4433;padding:3px 10px;font-size:11.5px}` +
    `</style></head><body><main>` +
    `<a class="logo" href="${esc(origin)}/">NOIZ LAB</a>` +
    `<h1>${esc(title)}</h1>` +
    `<img src="${esc(img)}" alt="${esc(title)}">` +
    `<div class="meta">` +
    `<a class="btn" href="${esc(origin)}/#w=${esc(id)}">この作品をエディタで開く</a>` +
    `<span class="expiry">この共有リンクは残り約${remainH}時間で失効します</span>` +
    `</div></main></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } }
  );
}

async function deleteWork(req, env, id) {
  if (!authed(req, env)) return json({ error: "unauthorized" }, 401);
  await env.IMAGES.delete([`works/${id}/source`, `works/${id}/thumb`]);
  await env.DB.prepare(`DELETE FROM works WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}

// サムネイルのキャプション生成 → 埋め込みベクトル化 → D1へ保存
// 検証済みの形状: llava は {description}, bge-m3 は data[0] が1024次元
async function computeEmbedding(env, ai, id) {
  if (!ai) return { error: "ai disabled", status: 503 };
  const row = await env.DB.prepare(
    "SELECT prompt, caption, embedding FROM works WHERE id = ?"
  ).bind(id).first();
  if (!row) return { error: "not found", status: 404 };
  if (row.embedding) {
    try {
      return { caption: row.caption, embedding: JSON.parse(row.embedding) };
    } catch { /* 壊れた行は再計算する */ }
  }
  const obj = await env.IMAGES.get(`works/${id}/thumb`);
  if (!obj) return { error: "no thumb", status: 404 };
  if (!(await spendAiBudget(env, AI_COST.caption + AI_COST.embed)).ok) {
    return { error: "quota exceeded", status: 503 };
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const caption = await ai.caption({
    bytes,
    prompt: "Describe this image in one concise sentence, focusing on subject, colors and mood.",
    maxTokens: 64,
  });
  const text = row.prompt ? `${caption} / ${row.prompt}` : caption;
  const vec = (await ai.embed({ text: text || "abstract image" }))
    .map((v) => Math.round(v * 1e5) / 1e5);
  if (!vec.length) throw new Error("empty embedding");
  await env.DB.prepare("UPDATE works SET caption = ?, embedding = ? WHERE id = ?")
    .bind(caption, JSON.stringify(vec), id).run();
  return { caption, embedding: vec };
}

async function embedRoute(req, env, ai, id) {
  if (!authed(req, env)) return json({ error: "unauthorized" }, 401);
  if (!(await rateLimit(env, clientIp(req) + "#embed", 20))) {
    return json({ error: "rate limited" }, 429);
  }
  try {
    const r = await computeEmbedding(env, ai, id);
    if (r.error) return json({ error: r.error }, r.status);
    return json(r);
  } catch (e) {
    const msg = e?.message ?? String(e);
    console.error("embed failed:", msg);
    if (msg.includes("4006") || msg.includes("neurons")) {
      return json({ error: "quota exceeded" }, 503);
    }
    return json({ error: "embed failed" }, 500);
  }
}

// ベクター風シーン仕様の生成（テキスト→JSON→クライアントがCanvas描画）
const SCENE_SYSTEM = [
  "You convert a short Japanese or English scene description into a JSON spec for a flat vector-style landscape renderer.",
  "Reply with ONLY minified JSON. No code fences, no explanations.",
  'Schema: {"sky":[2-4 hex colors, top to bottom],"horizon":0.55-0.85,"celestial":{"type":"sun|moon|none","x":0-1,"y":0-1 (0=top, keep above horizon),"r":0.04-0.14,"color":"#hex","glow":"#hex"},"stars":0-150 (0 unless night),"clouds":{"count":0-8,"color":"#hex"},"ground":{"type":"sea|grid|mountains|city|plain","colors":[1-4 hex colors; mountains: 2-4 layers near to far; city: 1 silhouette color; sea/plain: 1 base color; grid: 1 line color]},"rain":0-200,"snow":0-200,"sakura":0-120 (falling cherry petals),"birds":0-10,"fireworks":[0-3 bursts {"x":0-1,"y":0.1-0.5,"r":0.05-0.15,"color":"#hex"}],"aurora":null or {"colors":[1-3 hex]},"torii":null or {"x":0-1,"size":0.15-0.5,"color":"#hex"} (Japanese shrine gate silhouette),"signs":[0-4 neon signs {"text":"up to 6 chars, Japanese ok","color":"#hex","x":0.1-0.9,"y":0.15-0.6}]}',
  "Optional motifs (rain, snow, sakura, fireworks, aurora, torii, signs) only when the description calls for them; otherwise 0 / null / [].",
  "Choose emotionally evocative palettes that match the described time, weather and mood (emo / vaporwave / Japanese dusk aesthetics welcome). Vary palettes: morning=pale blues, noon=clear, dusk=magenta/orange, night=deep indigo.",
  'Example. User: 雨のネオン街 → {"sky":["#07070f","#141024","#1c1230"],"horizon":0.72,"celestial":{"type":"none","x":0.5,"y":0.3,"r":0.06,"color":"#ffeecf","glow":"#ff7a3c"},"stars":0,"clouds":{"count":2,"color":"#221a38"},"ground":{"type":"city","colors":["#0b0b14"]},"rain":160,"snow":0,"sakura":0,"birds":0,"fireworks":[],"aurora":null,"torii":null,"signs":[{"text":"ネオン","color":"#ff3ea5","x":0.2,"y":0.28},{"text":"BAR","color":"#35e0ff","x":0.75,"y":0.4}]}',
  'Example. User: 桜舞う神社の夕暮れ → {"sky":["#4a2c5e","#c66a8a","#ffb98a"],"horizon":0.7,"celestial":{"type":"sun","x":0.35,"y":0.45,"r":0.07,"color":"#ffdca0","glow":"#ff8a5c"},"stars":0,"clouds":{"count":3,"color":"#7a4a6e"},"ground":{"type":"plain","colors":["#241530"]},"rain":0,"snow":0,"sakura":90,"birds":3,"fireworks":[],"aurora":null,"torii":{"x":0.5,"size":0.42,"color":"#2e0f1c"},"signs":[]}',
].join("\n");

// 応答の前後にゴミが付いても最後にパースできる閉じ括弧まで遡って抽出する（配列/オブジェクト両対応）
function extractJson(text) {
  const tryFrom = (open, close) => {
    const start = text.indexOf(open);
    if (start < 0) return null;
    let end = text.lastIndexOf(close);
    while (end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch { /* ひとつ前の閉じ括弧で再試行 */ }
      end = text.lastIndexOf(close, end - 1);
    }
    return null;
  };
  const objAt = text.indexOf("{");
  const arrAt = text.indexOf("[");
  // 先に現れた方を優先して試す
  if (arrAt >= 0 && (objAt < 0 || arrAt < objAt)) {
    return tryFrom("[", "]") ?? tryFrom("{", "}");
  }
  return tryFrom("{", "}") ?? tryFrom("[", "]");
}

async function sceneRoute(req, env, ai) {
  if (!(await rateLimit(env, clientIp(req) + "#scene", 10))) {
    return json({ error: "rate limited" }, 429);
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const prompt = body?.prompt;
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 300) {
    return json({ error: "invalid prompt" }, 400);
  }
  if (!(await spendAiBudget(env, AI_COST.llm70b)).ok) return budgetExceeded();

  try {
    const raw = await ai.chat({
      system: SCENE_SYSTEM,
      user: prompt.trim(),
      maxTokens: 700,
    });
    // モデル/ランタイムによりresponseが文字列でなくパース済みオブジェクトの場合がある
    const spec =
      raw && typeof raw === "object" ? raw : extractJson(String(raw ?? ""));
    if (!spec || typeof spec !== "object") {
      console.error("scene parse failed:", String(raw).slice(0, 200));
      return json({ error: "parse failed" }, 502);
    }
    return json({ spec });
  } catch (e) {
    const msg = e?.message ?? String(e);
    console.error("scene failed:", msg);
    if (msg.includes("4006") || msg.includes("neurons")) {
      return json({ error: "quota exceeded" }, 503);
    }
    return json({ error: "scene failed" }, 500);
  }
}

// ナレッジグラフの「穴」から次に作る作品を提案する。
// 穴の検出はクライアント側で済ませ、ここは言語化だけを担当する。
const SUGGEST_SYSTEM = [
  "You help an artist decide what image to create next, based on gaps found in their artwork collection graph.",
  "Reply with ONLY minified JSON: an array of objects, one per gap, in the same order as the input gaps.",
  'Each object: {"title":"短い日本語の作品タイトル案(15文字以内)","why":"なぜ今これを作ると良いかを1文で(40文字以内、日本語)","scenePrompt":"シーン生成用の日本語プロンプト(30文字以内)"}',
  "The scene renderer is a flat vector-style landscape drawer. Its motifs are limited to: 空/グラデーション, 太陽, 月, 星, 雲, 海, 遠近グリッド, 山, 街のシルエット, 雨, 雪, 桜の花びら, 花火, オーロラ, 鳥居, ネオン看板, 鳥.",
  "scenePrompt MUST be renderable with only those motifs. Never ask for people, animals (except birds), close-up objects, or photorealism.",
  "Make each suggestion concretely different from the existing works described in the input.",
].join("\n");

async function suggestRoute(req, env, ai) {
  if (!authed(req, env)) return json({ error: "unauthorized" }, 401);
  if (!(await rateLimit(env, clientIp(req) + "#suggest", 10))) {
    return json({ error: "rate limited" }, 429);
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const gaps = Array.isArray(body?.gaps) ? body.gaps.slice(0, 5) : [];
  if (!gaps.length) return json({ error: "no gaps" }, 400);
  const captions = (Array.isArray(body?.captions) ? body.captions : [])
    .filter((c) => typeof c === "string" && c.trim())
    .slice(0, 12)
    .map((c) => c.slice(0, 120));

  const userMsg = [
    captions.length
      ? `Existing works in the collection:\n${captions.map((c, i) => `${i + 1}. ${c}`).join("\n")}`
      : "The collection is nearly empty.",
    "",
    "Gaps found in the collection graph:",
    ...gaps.map((g, i) => `${i + 1}. [${String(g?.kind ?? "gap").slice(0, 24)}] ${String(g?.desc ?? "").slice(0, 200)}`),
  ].join("\n");

  if (!(await spendAiBudget(env, AI_COST.llm70b)).ok) return budgetExceeded();

  try {
    const raw = await ai.chat({
      system: SUGGEST_SYSTEM,
      user: userMsg,
      maxTokens: 700,
    });
    // モデル/ランタイムによりresponseが文字列でなくパース済みの場合がある
    let parsed = raw && typeof raw === "object" ? raw : extractJson(String(raw ?? ""));
    if (parsed && !Array.isArray(parsed)) {
      parsed = Array.isArray(parsed.suggestions) ? parsed.suggestions : [parsed];
    }
    if (!Array.isArray(parsed)) {
      console.error("suggest parse failed:", String(raw).slice(0, 200));
      return json({ error: "parse failed" }, 502);
    }
    return json({ suggestions: parsed.slice(0, gaps.length) });
  } catch (e) {
    const msg = e?.message ?? String(e);
    console.error("suggest failed:", msg);
    if (msg.includes("4006") || msg.includes("neurons")) {
      return json({ error: "quota exceeded" }, 503);
    }
    return json({ error: "suggest failed" }, 500);
  }
}

// 静的HTMLのog:url/og:imageを、実際に配信しているoriginの絶対URLに書き換える。
// これによりfork先でも設定なしで正しいOGPになる。
function rewriteOgp(res, origin) {
  if (!(res.headers.get("content-type") || "").includes("text/html")) return res;
  // HTMLRewriterはセレクタリスト(カンマ区切り)に対応しないため個別に登録する
  const absolutize = {
    element(el) {
      const c = el.getAttribute("content");
      if (c && c.startsWith("/")) el.setAttribute("content", origin + c);
    },
  };
  return new HTMLRewriter()
    .on('meta[property="og:url"]', absolutize)
    .on('meta[property="og:image"]', absolutize)
    .on('meta[name="twitter:image"]', absolutize)
    .transform(res);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const { pathname } = url;
    const ai = getAiProvider(env);
    const gallery = galleryEnabled(env);

    // フロントに構成を伝える。AIやギャラリーが無い構成では該当UIを隠す
    if (pathname === "/api/config") {
      return new Response(
        JSON.stringify({ ai: !!ai, gallery, aiProvider: ai?.name ?? "none" }),
        { headers: { "content-type": "application/json", "cache-control": "no-store" } }
      );
    }

    if (pathname === "/api/generate" && req.method === "POST") {
      if (!ai) return disabled("ai");
      return handleGenerate(req, env, ai);
    }
    if (pathname === "/api/scene" && req.method === "POST") {
      if (!ai) return disabled("ai");
      return sceneRoute(req, env, ai);
    }

    // 当日のAI使用量の確認用（消費0で現在値だけ読む）
    if (pathname === "/api/budget" && req.method === "GET") {
      if (!authed(req, env)) return json({ error: "unauthorized" }, 401);
      const b = await spendAiBudget(env, 0);
      return json({ used: b.used, cap: b.cap, freeAllocation: 10000 });
    }

    if (pathname === "/api/suggest" && req.method === "POST") {
      if (!ai) return disabled("ai");
      return suggestRoute(req, env, ai);
    }

    if (pathname.startsWith("/api/works") && !gallery) return disabled("gallery");
    if (pathname === "/api/works" && req.method === "POST") return saveWork(req, env, ctx, ai);
    if (pathname === "/api/works" && req.method === "GET") return listWorks(req, env);

    // 共有ページ（作品ごと・24時間で失効）
    const sm = pathname.match(/^\/w\/([0-9a-f-]{36})$/);
    if (sm && req.method === "GET" && gallery) {
      return sharePage(sm[1], await sharedMeta(env, sm[1]), url.origin);
    }

    const m = pathname.match(/^\/api\/works\/([0-9a-f-]{36})(?:\/(source|thumb|embed|share|meta))?$/);
    if (m) {
      if (req.method === "GET" && (m[2] === "source" || m[2] === "thumb")) {
        return getWorkImage(req, env, url, m[1], m[2]);
      }
      if (req.method === "POST" && m[2] === "embed") {
        if (!ai) return disabled("ai");
        return embedRoute(req, env, ai, m[1]);
      }
      if (req.method === "POST" && m[2] === "share") return shareWork(req, env, m[1]);
      if (req.method === "GET" && m[2] === "meta") {
        const meta = await sharedMeta(env, m[1]);
        return meta ? json(meta) : json({ error: "not shared" }, 404);
      }
      if (req.method === "DELETE" && !m[2]) return deleteWork(req, env, m[1]);
    }

    // OGPの絶対URLはデプロイ先で変わるため、配信時にoriginを埋める
    return rewriteOgp(await env.ASSETS.fetch(req), url.origin);
  },
};
