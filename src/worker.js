const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === "/api/generate" && req.method === "POST") {
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
        return json({ error: "generation failed" }, 500);
      }
    }

    return env.ASSETS.fetch(req);
  },
};
