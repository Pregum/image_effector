import { DurableObject } from "cloudflare:workers";

const RATE_LIMIT = 5;       // 許可回数
const WINDOW_MS = 60_000;   // ウィンドウ幅

// IPごとに1インスタンス割り当てて固定ウィンドウでカウントする
export class RateLimiter extends DurableObject {
  async check() {
    const now = Date.now();
    let w = (await this.ctx.storage.get("w")) ?? null;
    if (!w || now - w.start >= WINDOW_MS) w = { start: now, count: 0 };
    w.count++;
    await this.ctx.storage.put("w", w);
    return w.count <= RATE_LIMIT;
  }
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === "/api/generate" && req.method === "POST") {
      // IPごとのレート制限（5回/分）
      const ip = req.headers.get("cf-connecting-ip") || "unknown";
      const ok = await env.LIMITER.get(env.LIMITER.idFromName(ip)).check();
      if (!ok) return json({ error: "rate limited" }, 429);

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

    return env.ASSETS.fetch(req);
  },
};
