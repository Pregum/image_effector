// AIプロバイダの抽象化。
//
// アプリが必要とするAIは4種類だけ:
//   chat()    テキスト生成（シーン設計JSON・翻訳・提案）
//   image()   テキスト→画像
//   caption() 画像→テキスト（ギャラリーの埋め込み用）
//   embed()   テキスト→ベクトル（類似グラフ用）
//
// これらはOpenAI互換APIの標準的なカテゴリと一致するため、
// Ollama / LM Studio / vLLM / LiteLLM などに向けられる。
//
// 環境変数:
//   AI_PROVIDER   "workers-ai"(既定) | "openai" | "none"
//   AI_BASE_URL   openai時のエンドポイント (例: http://localhost:11434/v1)
//   AI_API_KEY    openai時のキー（ローカルAIなら不要なことが多い）
//   AI_MODEL_CHAT / AI_MODEL_CHAT_SMALL / AI_MODEL_IMAGE
//   AI_MODEL_VISION / AI_MODEL_EMBED

const WORKERS_AI_MODELS = {
  chat: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  chatSmall: "@cf/meta/llama-3.1-8b-instruct-fp8",
  image: "@cf/black-forest-labs/flux-1-schnell",
  vision: "@cf/llava-hf/llava-1.5-7b-hf",
  embed: "@cf/baai/bge-m3",
};

const OPENAI_MODELS = {
  chat: "gpt-4o-mini",
  chatSmall: "gpt-4o-mini",
  image: "dall-e-3",
  vision: "gpt-4o-mini",
  embed: "text-embedding-3-small",
};

function pickModels(env, defaults) {
  return {
    chat: env.AI_MODEL_CHAT || defaults.chat,
    chatSmall: env.AI_MODEL_CHAT_SMALL || env.AI_MODEL_CHAT || defaults.chatSmall,
    image: env.AI_MODEL_IMAGE || defaults.image,
    vision: env.AI_MODEL_VISION || defaults.vision,
    embed: env.AI_MODEL_EMBED || defaults.embed,
  };
}

function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// --- Workers AI ---
// 各モデルの入出力形状は実地で確認したものをそのまま踏襲している。
function workersAiProvider(env) {
  const m = pickModels(env, WORKERS_AI_MODELS);
  return {
    name: "workers-ai",
    models: m,
    async chat({ system, user, maxTokens = 700, small = false }) {
      const r = await env.AI.run(small ? m.chatSmall : m.chat, {
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          { role: "user", content: user },
        ],
        max_tokens: maxTokens,
      });
      // モデル/ランタイムによりresponseが文字列でなくパース済みオブジェクトのことがある
      return r?.response;
    },
    async image({ prompt, steps = 6 }) {
      const out = await env.AI.run(m.image, { prompt, steps });
      return { bytes: b64ToBytes(out.image), contentType: "image/jpeg" };
    },
    async caption({ bytes, prompt, maxTokens = 64 }) {
      const r = await env.AI.run(m.vision, {
        image: Array.from(bytes),
        prompt,
        max_tokens: maxTokens,
      });
      return (r?.description ?? "").trim();
    },
    async embed({ text }) {
      const r = await env.AI.run(m.embed, { text: [text] });
      return r?.data?.[0] ?? [];
    },
  };
}

// --- OpenAI互換（Ollama / LM Studio / vLLM / LiteLLM / OpenAI本家）---
function openAiProvider(env) {
  const m = pickModels(env, OPENAI_MODELS);
  const base = String(env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const headers = {
    "content-type": "application/json",
    ...(env.AI_API_KEY ? { authorization: `Bearer ${env.AI_API_KEY}` } : {}),
  };

  async function post(path, body) {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return res.json();
  }

  return {
    name: "openai",
    models: m,
    async chat({ system, user, maxTokens = 700, small = false }) {
      const j = await post("/chat/completions", {
        model: small ? m.chatSmall : m.chat,
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          { role: "user", content: user },
        ],
        max_tokens: maxTokens,
      });
      return j?.choices?.[0]?.message?.content ?? "";
    },
    async image({ prompt }) {
      const j = await post("/images/generations", {
        model: m.image,
        prompt,
        n: 1,
        response_format: "b64_json",
      });
      const d = j?.data?.[0];
      // 実装により b64_json / url のどちらかを返す
      if (d?.b64_json) return { bytes: b64ToBytes(d.b64_json), contentType: "image/png" };
      if (d?.url) {
        const res = await fetch(d.url);
        if (!res.ok) throw new Error(`image url ${res.status}`);
        return {
          bytes: new Uint8Array(await res.arrayBuffer()),
          contentType: res.headers.get("content-type") || "image/png",
        };
      }
      throw new Error("no image in response");
    },
    async caption({ bytes, prompt, maxTokens = 64 }) {
      const j = await post("/chat/completions", {
        model: m.vision,
        max_tokens: maxTokens,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: `data:image/webp;base64,${bytesToB64(bytes)}` },
              },
            ],
          },
        ],
      });
      return (j?.choices?.[0]?.message?.content ?? "").trim();
    },
    async embed({ text }) {
      const j = await post("/embeddings", { model: m.embed, input: text });
      return j?.data?.[0]?.embedding ?? [];
    },
  };
}

// AI機能を無効にした構成でも、エフェクト等は動き続ける
export function getAiProvider(env) {
  const mode = env.AI_PROVIDER || (env.AI ? "workers-ai" : "none");
  if (mode === "none") return null;
  if (mode === "openai") return openAiProvider(env);
  return env.AI ? workersAiProvider(env) : null;
}
