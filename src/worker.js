import { DurableObject } from "cloudflare:workers";

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
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });

const clientIp = (req) => req.headers.get("cf-connecting-ip") || "unknown";

async function rateLimit(env, key, limit) {
  return env.LIMITER.get(env.LIMITER.idFromName(key)).check(limit);
}

function authed(req, env) {
  if (!env.GALLERY_KEY) return false;
  return req.headers.get("x-gallery-key") === env.GALLERY_KEY;
}

// 日本語などの非ASCIIプロンプトを画像モデル向けに英訳する（失敗時は原文のまま）
async function translatePrompt(env, p) {
  if (!/[^\x00-\x7F]/.test(p)) return p;
  try {
    const tr = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fp8", {
      messages: [
        {
          role: "system",
          content:
            "Translate the user's image description into a concise English prompt for an image generation model. Reply with the prompt only, no quotes.",
        },
        { role: "user", content: p },
      ],
    });
    return tr?.response?.trim() || p;
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

async function handleGenerate(req, env) {
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

  const p = await translatePrompt(env, prompt.trim());

  try {
    const out = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
      prompt: p,
      steps: 6,
    });
    const bin = Uint8Array.from(atob(out.image), (c) => c.charCodeAt(0));
    return new Response(bin, {
      headers: { "content-type": "image/jpeg", "cache-control": "no-store" },
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

async function saveWork(req, env, ctx) {
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
    computeEmbedding(env, id).catch((e) =>
      console.error("bg embed failed:", e?.message ?? e)
    )
  );

  return json({ id });
}

async function listWorks(req, env) {
  if (!authed(req, env)) return json({ error: "unauthorized" }, 401);
  const { results } = await env.DB.prepare(
    `SELECT id, created_at, prompt, recipe, width, height, caption, embedding, parent_a, parent_b
     FROM works ORDER BY created_at DESC LIMIT 200`
  ).all();
  return json({
    works: results.map((r) => {
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
        recipe,
        embedding,
      };
    }),
  });
}

async function getWorkImage(env, id, kind) {
  const obj = await env.IMAGES.get(`works/${id}/${kind}`);
  if (!obj) return json({ error: "not found" }, 404);
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType || "image/webp",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

async function deleteWork(req, env, id) {
  if (!authed(req, env)) return json({ error: "unauthorized" }, 401);
  await env.IMAGES.delete([`works/${id}/source`, `works/${id}/thumb`]);
  await env.DB.prepare(`DELETE FROM works WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}

// サムネイルのキャプション生成 → 埋め込みベクトル化 → D1へ保存
// 検証済みの形状: llava は {description}, bge-m3 は data[0] が1024次元
async function computeEmbedding(env, id) {
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
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const cap = await env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", {
    image: Array.from(bytes),
    prompt: "Describe this image in one concise sentence, focusing on subject, colors and mood.",
    max_tokens: 64,
  });
  const caption = (cap?.description ?? "").trim();
  const text = row.prompt ? `${caption} / ${row.prompt}` : caption;
  const emb = await env.AI.run("@cf/baai/bge-m3", { text: [text || "abstract image"] });
  const vec = (emb?.data?.[0] ?? []).map((v) => Math.round(v * 1e5) / 1e5);
  if (!vec.length) throw new Error("empty embedding");
  await env.DB.prepare("UPDATE works SET caption = ?, embedding = ? WHERE id = ?")
    .bind(caption, JSON.stringify(vec), id).run();
  return { caption, embedding: vec };
}

async function embedRoute(req, env, id) {
  if (!authed(req, env)) return json({ error: "unauthorized" }, 401);
  if (!(await rateLimit(env, clientIp(req) + "#embed", 20))) {
    return json({ error: "rate limited" }, 429);
  }
  try {
    const r = await computeEmbedding(env, id);
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

async function sceneRoute(req, env) {
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
  try {
    const r = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        { role: "system", content: SCENE_SYSTEM },
        { role: "user", content: prompt.trim() },
      ],
      max_tokens: 700,
    });
    // モデル/ランタイムによりresponseが文字列でなくパース済みオブジェクトの場合がある
    const raw = r?.response;
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

async function suggestRoute(req, env) {
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

  try {
    const r = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        { role: "system", content: SUGGEST_SYSTEM },
        { role: "user", content: userMsg },
      ],
      max_tokens: 700,
    });
    const raw = r?.response;
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

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/api/generate" && req.method === "POST") {
      return handleGenerate(req, env);
    }
    if (pathname === "/api/scene" && req.method === "POST") {
      return sceneRoute(req, env);
    }

    if (pathname === "/api/suggest" && req.method === "POST") return suggestRoute(req, env);

    if (pathname === "/api/works" && req.method === "POST") return saveWork(req, env, ctx);
    if (pathname === "/api/works" && req.method === "GET") return listWorks(req, env);

    const m = pathname.match(/^\/api\/works\/([0-9a-f-]{36})(?:\/(source|thumb|embed))?$/);
    if (m) {
      if (req.method === "GET" && (m[2] === "source" || m[2] === "thumb")) {
        return getWorkImage(env, m[1], m[2]);
      }
      if (req.method === "POST" && m[2] === "embed") return embedRoute(req, env, m[1]);
      if (req.method === "DELETE" && !m[2]) return deleteWork(req, env, m[1]);
    }

    return env.ASSETS.fetch(req);
  },
};
