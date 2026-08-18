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

  let p = prompt.trim();
  // 日本語などの非ASCIIプロンプトは英語に翻訳してから画像生成に渡す
  if (/[^\x00-\x7F]/.test(p)) {
    try {
      const tr = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: [
          {
            role: "system",
            content:
              "Translate the user's image description into a concise English prompt for an image generation model. Reply with the prompt only, no quotes.",
          },
          { role: "user", content: p },
        ],
      });
      if (tr?.response?.trim()) p = tr.response.trim();
    } catch {
      // 翻訳失敗時は原文のまま生成を試みる
    }
  }

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

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/api/generate" && req.method === "POST") {
      return handleGenerate(req, env);
    }

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
