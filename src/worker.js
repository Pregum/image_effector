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

async function saveWork(req, env) {
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
    `INSERT INTO works (id, created_at, prompt, recipe, width, height, source_type, thumb_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      Date.now(),
      typeof meta.prompt === "string" ? meta.prompt.slice(0, 500) : null,
      JSON.stringify(recipe),
      width,
      height,
      sourceType,
      thumbType
    )
    .run();

  return json({ id });
}

async function listWorks(req, env) {
  if (!authed(req, env)) return json({ error: "unauthorized" }, 401);
  const { results } = await env.DB.prepare(
    `SELECT id, created_at, prompt, recipe, width, height FROM works
     ORDER BY created_at DESC LIMIT 200`
  ).all();
  return json({
    works: results.map((r) => ({ ...r, recipe: JSON.parse(r.recipe) })),
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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/api/generate" && req.method === "POST") {
      return handleGenerate(req, env);
    }

    if (pathname === "/api/works" && req.method === "POST") return saveWork(req, env);
    if (pathname === "/api/works" && req.method === "GET") return listWorks(req, env);

    const m = pathname.match(/^\/api\/works\/([0-9a-f-]{36})(?:\/(source|thumb))?$/);
    if (m) {
      if (req.method === "GET" && m[2]) return getWorkImage(env, m[1], m[2]);
      if (req.method === "DELETE" && !m[2]) return deleteWork(req, env, m[1]);
    }

    return env.ASSETS.fetch(req);
  },
};
