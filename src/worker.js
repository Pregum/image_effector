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

// ---------------------------------------------------------------- 計測（需要の把握）
// 「どの機能がどれだけ使われているか」だけを知るための仕組み。
// 個人は追跡しない: IP・User-Agent・プロンプト本文・画像は一切記録せず、
// 地域は国コードまでに丸める。Analytics Engineのバインディングが無い構成
// （Tier 1 / 静的ホスティング / ローカル）では丸ごと何もしない。
function trackEvent(env, req, event, label = "", value = 1) {
  if (!env.ANALYTICS) return;
  try {
    env.ANALYTICS.writeDataPoint({
      // サンプリングの単位。1データポイントにつき1つだけ指定できる
      indexes: [event],
      blobs: [event, String(label ?? "").slice(0, 64), req?.cf?.country ?? "XX"],
      doubles: [Number(value) || 0],
    });
  } catch {
    // 計測の失敗で本来の処理を止めない
  }
}

// ハンドラの結果（成否）まで含めて1件記録する
async function tracked(env, req, event, promise) {
  const res = await promise;
  trackEvent(env, req, event, res.ok ? "ok" : String(res.status));
  return res;
}

// クライアントから受け付けるイベント名。許可リストの外は捨てる
// （任意の文字列をデータセットに書き込ませない）
const CLIENT_EVENTS = new Set([
  "app_open",    // エディタが実際に起動した
  "effect_on",   // エフェクトをONにした（label = エフェクトID）
  "preset",      // プリセットを選んだ（label = プリセット名）
  "random",      // おまかせ
  "sample",      // サンプル画像の切り替え
  "open_image",  // 自分の画像を開いた
  "export",      // 書き出し（label = png / mp4 / webm / gif）
  "share",       // 共有ボタン（label = image / url）
]);

const MAX_EVENT_BODY = 4096;
const MAX_EVENTS_PER_REQ = 20;

async function handleEvent(req, env) {
  // 計測先が無い構成では受け取らない（クライアントも/api/configを見て送信しない）
  if (!env.ANALYTICS) return new Response(null, { status: 204 });
  if (Number(req.headers.get("content-length")) > MAX_EVENT_BODY) {
    return new Response(null, { status: 204 });
  }
  if (!(await rateLimit(env, clientIp(req) + "#ev", 60))) {
    return new Response(null, { status: 204 });
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(null, { status: 204 });
  }
  const list = Array.isArray(body?.events) ? body.events.slice(0, MAX_EVENTS_PER_REQ) : [];
  for (const it of list) {
    if (!CLIENT_EVENTS.has(it?.e)) continue;
    trackEvent(env, req, it.e, typeof it.l === "string" ? it.l : "", Number(it.v) || 1);
  }
  // 計測は本流ではないので、失敗も成功も同じ204で返す
  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------- 外部の計測タグ
// 環境変数が設定されているときだけ<head>に足す。未設定なら1バイトも入らないので、
// forkした人の計測先が作者になることはない。値は形式を検証し、外れたものは無視する。
const TAG_PATTERNS = {
  WEB_ANALYTICS_TOKEN: /^[0-9a-f]{32}$/i,        // Cloudflare Web Analyticsのトークン
  GA_MEASUREMENT_ID: /^G-[A-Z0-9]{4,20}$/i,      // GA4の測定ID
  PLAUSIBLE_DOMAIN: /^[a-z0-9.-]{3,120}$/i,      // Plausible等に登録したドメイン
};

function tagValue(env, name) {
  const v = env[name];
  if (!v) return null;
  if (TAG_PATTERNS[name].test(v)) return v;
  console.warn(`analytics: ${name} の形式が不正なため無視しました`);
  return null;
}

function analyticsTags(env) {
  const out = [];
  const cf = tagValue(env, "WEB_ANALYTICS_TOKEN");
  if (cf) {
    out.push(
      `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" ` +
      `data-cf-beacon='{"token":"${cf}"}'></script>`
    );
  }
  const plausible = tagValue(env, "PLAUSIBLE_DOMAIN");
  if (plausible) {
    // セルフホスト版を使う場合は PLAUSIBLE_SRC でスクリプトの場所を差し替える
    const src = env.PLAUSIBLE_SRC || "https://plausible.io/js/script.js";
    if (/^https:\/\/[a-z0-9.\-\/]+\.js$/i.test(src)) {
      out.push(`<script defer data-domain="${plausible}" src="${src}"></script>`);
    }
  }
  const ga = tagValue(env, "GA_MEASUREMENT_ID");
  if (ga) {
    out.push(
      `<script async src="https://www.googletagmanager.com/gtag/js?id=${ga}"></script>` +
      `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}` +
      `gtag('js',new Date());gtag('config','${ga}');</script>`
    );
  }
  return out.join("");
}

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
    // アクセスキーが無くてもシェアできるように、生成した画像だけを共有用に置いておく。
    // 置けなくても生成自体は成功させる（共有できないだけ）
    let shareId = null;
    try {
      shareId = await putAiShare(env, out.bytes, out.contentType, prompt.trim());
    } catch (e) {
      console.error("ai share put failed:", e?.message ?? String(e));
    }
    const headers = { "content-type": out.contentType, "cache-control": "no-store" };
    if (shareId) headers["x-share-id"] = shareId;
    return new Response(out.bytes, { headers });
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

// OGP用画像の最大辺。SNSのカードは幅600px前後まで拡大されるため、
// ギャラリー一覧用のサムネ(360px)ではぼやける。app.js の書き出しと同じ値にすること。
const OG_MAX_EDGE = 1200;
const THUMB_MAX_EDGE = 360;
// og:image:width/height に実寸を書くため、クライアントの書き出しと同じ縮小率を再現する
const scaled = (w, h, scale) => ({
  w: Math.max(1, Math.round(w * scale)),
  h: Math.max(1, Math.round(h * scale)),
});
const ogSize = (w, h) => scaled(w, h, Math.min(1, OG_MAX_EDGE / Math.max(w, h)));
// サムネは従来から幅基準（縦長でも幅360pxまで）
const thumbSize = (w, h) => scaled(w, h, Math.min(1, THUMB_MAX_EDGE / w));

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
  // OGP用の大きめの画像。古いクライアントからは送られてこないので任意扱い
  const ogImage = form.get("og");
  const metaRaw = form.get("meta");
  if (!(source instanceof File) || !(thumb instanceof File) || typeof metaRaw !== "string") {
    return json({ error: "missing fields" }, 400);
  }
  if (source.size > MAX_BLOB || thumb.size > MAX_BLOB) {
    return json({ error: "file too large" }, 413);
  }
  if (ogImage instanceof File && ogImage.size > MAX_BLOB) {
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
  if (ogImage instanceof File) {
    await env.IMAGES.put(`works/${id}/og`, ogImage.stream(), {
      httpMetadata: { contentType: ogImage.type || "image/jpeg" },
    });
  }
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
    "SELECT recipe, width, height, prompt, thumb_type, shared FROM works WHERE id = ?"
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
    thumb_type: row.thumb_type || "image/webp",
    shared_until: until,
  };
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// OGPに出す画像を選ぶ。OGP用の大きい版があればそれを、無ければサムネにフォールバックする
// （og:image:width/height は実寸と食い違うとカードが崩れるので、選んだ方に合わせて出す）
async function shareImage(env, id, meta) {
  const og = await env.IMAGES.head(`works/${id}/og`).catch(() => null);
  const { w, h } = og ? ogSize(meta.width, meta.height) : thumbSize(meta.width, meta.height);
  return {
    path: og ? `/api/works/${id}/og` : `/api/works/${id}/thumb`,
    type: og ? og.httpMetadata?.contentType || "image/jpeg" : meta.thumb_type,
    width: w,
    height: h,
  };
}

// 共有ページのHTML。作品の共有(/w/)とAI生成画像の共有(/s/)で見た目とOGPを揃える。
// width/height が分からないときは省く（実寸と食い違うとカードが崩れるため）
function sharePageHtml({ title, desc, shareUrl, img, imgType, width, height, origin, editHref, editLabel, remainH }) {
  const sized = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
  return (
    `<!doctype html><html lang="ja"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)} — NOIZ LAB</title>` +
    `<meta name="description" content="${esc(desc)}">` +
    `<link rel="canonical" href="${esc(shareUrl)}">` +
    `<meta property="og:type" content="website">` +
    `<meta property="og:site_name" content="NOIZ LAB">` +
    `<meta property="og:locale" content="ja_JP">` +
    `<meta property="og:url" content="${esc(shareUrl)}">` +
    `<meta property="og:title" content="${esc(title)}">` +
    `<meta property="og:description" content="${esc(desc)}">` +
    // 画像そのものがカードに出るように絶対URLで指す。
    // 幅・高さ・MIMEを添えるとクローラが取得前にカードを組み立てられる
    `<meta property="og:image" content="${esc(img)}">` +
    `<meta property="og:image:type" content="${esc(imgType)}">` +
    (sized ? `<meta property="og:image:width" content="${width}">` : "") +
    (sized ? `<meta property="og:image:height" content="${height}">` : "") +
    `<meta property="og:image:alt" content="${esc(title)}">` +
    `<meta name="twitter:card" content="summary_large_image">` +
    `<meta name="twitter:title" content="${esc(title)}">` +
    `<meta name="twitter:description" content="${esc(desc)}">` +
    `<meta name="twitter:image" content="${esc(img)}">` +
    `<meta name="twitter:image:alt" content="${esc(title)}">` +
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
    `<img src="${esc(img)}"${sized ? ` width="${width}" height="${height}"` : ""} alt="${esc(title)}">` +
    `<div class="meta">` +
    `<a class="btn" href="${esc(editHref)}">${esc(editLabel)}</a>` +
    `<span class="expiry">この共有リンクは残り約${remainH}時間で失効します</span>` +
    `</div></main></body></html>`
  );
}

const SHARE_PAGE_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" };

function expiredPage(origin) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>共有リンクの期限切れ — NOIZ LAB</title>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>body{background:#0b0d0c;color:#e8e6df;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center;line-height:1.9}a{color:#c8ff00}</style>` +
    `<div><h1 style="font-size:20px">この共有リンクは期限切れです</h1>` +
    `<p style="color:#8b917e;font-size:14px">共有リンクは作成から約1日で自動的に無効になります。<br>` +
    `もう一度見るには、共有した人にリンクを作り直してもらってください。</p>` +
    `<p><a href="${esc(origin)}/">NOIZ LAB を開く</a></p></div>`,
    { status: 410, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } }
  );
}

async function sharePage(id, meta, origin, env) {
  if (!meta) return expiredPage(origin);
  // captionはLLaVA生成の内部データなので公開ページには出さない
  const title = meta.prompt || "NOIZ LAB の作品";
  const pic = await shareImage(env, id, meta);
  return new Response(
    sharePageHtml({
      title,
      desc: "NOIZ LAB で作った画像。リンクは約1日で失効します。",
      shareUrl: `${origin}/w/${id}`,
      img: origin + pic.path,
      imgType: pic.type,
      width: pic.width,
      height: pic.height,
      origin,
      editHref: `${origin}/#w=${id}`,
      editLabel: "この作品をエディタで開く",
      remainH: Math.max(1, Math.round((meta.shared_until - Date.now()) / 3600000)),
    }),
    { headers: SHARE_PAGE_HEADERS }
  );
}

// ---- AI生成画像の共有（アクセスキー不要）
//
// ギャラリーへの保存はアクセスキーが要るため、キーを持たない人がシェアを押すと
// レシピURLしか投稿できず、カードに画像が出せなかった。
// そこで /api/generate が作った画像そのものだけを、約1日で失効する形で置いておく。
// ブラウザからのアップロードは一切受け付けないので、任意の画像をドメイン上に
// 置かれることはない。裏を返すと、カードに出るのはエフェクトをかける前の絵になる。

// og:image:width/height に実寸を書くためだけの最小限のヘッダ解析。
// 読めなければ null を返し、幅・高さを省いたカードにする
function imageSize(bytes, contentType) {
  try {
    const d = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (contentType === "image/png" || (d[0] === 0x89 && d[1] === 0x50)) {
      const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
      // 8バイトのシグネチャ + 長さ4 + "IHDR"4 のあとに幅・高さが並ぶ
      if (d.byteLength > 24) return { width: v.getUint32(16), height: v.getUint32(20) };
      return null;
    }
    // JPEG: SOF0/1/2 セグメントの中に高さ・幅がこの順で入っている
    let i = 2;
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    while (i + 9 < d.byteLength) {
      if (d[i] !== 0xff) return null;
      const marker = d[i + 1];
      const len = v.getUint16(i + 2);
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        return { width: v.getUint16(i + 7), height: v.getUint16(i + 5) };
      }
      i += 2 + len;
    }
  } catch { /* 壊れていても共有自体は続ける */ }
  return null;
}

const aiShareKey = (id) => `shares/${id}`;

// 生成した画像を置いて共有IDを返す。R2が無い構成では何もしない
async function putAiShare(env, bytes, contentType, prompt) {
  if (!env.IMAGES) return null;
  const id = crypto.randomUUID();
  const size = imageSize(bytes, contentType);
  await env.IMAGES.put(aiShareKey(id), bytes, {
    httpMetadata: { contentType },
    // 期限や実寸はR2のメタデータに持たせる（D1のスキーマ変更を避けるため）
    customMetadata: {
      until: String(Date.now() + SHARE_TTL_MS),
      prompt: (prompt || "").slice(0, 200),
      w: String(size?.width ?? 0),
      h: String(size?.height ?? 0),
    },
  });
  return id;
}

// 期限内なら中身を返す。切れていたらその場で消す（定期実行が無いので遅延削除）
async function getAiShare(env, id, bodyToo) {
  if (!env.IMAGES) return null;
  const obj = bodyToo ? await env.IMAGES.get(aiShareKey(id)) : await env.IMAGES.head(aiShareKey(id));
  if (!obj) return null;
  const until = Number(obj.customMetadata?.until) || 0;
  if (until <= Date.now()) {
    await env.IMAGES.delete(aiShareKey(id)).catch(() => {});
    return null;
  }
  return {
    obj,
    until,
    prompt: obj.customMetadata?.prompt || "",
    width: Number(obj.customMetadata?.w) || 0,
    height: Number(obj.customMetadata?.h) || 0,
    type: obj.httpMetadata?.contentType || "image/jpeg",
  };
}

async function aiSharePage(env, id, origin) {
  const info = await getAiShare(env, id, false);
  if (!info) return expiredPage(origin);
  const remain = Math.floor((info.until - Date.now()) / 1000);
  return new Response(
    sharePageHtml({
      title: info.prompt || "NOIZ LAB で生成した画像",
      desc: "NOIZ LAB のAI生成でつくった画像。リンクは約1日で失効します。",
      shareUrl: `${origin}/s/${id}`,
      img: `${origin}/api/shares/${id}/image`,
      imgType: info.type,
      width: info.width,
      height: info.height,
      origin,
      editHref: `${origin}/`,
      editLabel: "NOIZ LAB を開く",
      remainH: Math.max(1, Math.round(remain / 3600)),
    }),
    { headers: SHARE_PAGE_HEADERS }
  );
}

async function aiShareImage(env, id) {
  const info = await getAiShare(env, id, true);
  if (!info) return json({ error: "not found" }, 404);
  const remain = Math.floor((info.until - Date.now()) / 1000);
  return new Response(info.obj.body, {
    headers: {
      "content-type": info.type,
      // 共有期限を超えてキャッシュに残らないようにする
      "cache-control": `public, max-age=${Math.min(Math.max(remain, 0), 3600)}`,
    },
  });
}

async function deleteWork(req, env, id) {
  if (!authed(req, env)) return json({ error: "unauthorized" }, 401);
  await env.IMAGES.delete([`works/${id}/source`, `works/${id}/thumb`, `works/${id}/og`]);
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

// Uint8Array -> base64。btoaは引数長に上限があるため分割して渡す
function bytesToBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

// 絵コンテの各カット向けに不足素材をまとめて生成する。
// 1枚ずつ /api/generate を叩くのに比べ、スタイルバイブルの適用と予算判定を
// 1リクエストにまとめられる。生成物はbase64で返し、保存先は呼び出し側が決める。
const MAX_BATCH_ASSETS = 8;

async function assetsRoute(req, env, ai) {
  // 画像生成は重いので、1リクエストで最大8枚という上限に合わせて枠を絞る
  if (!(await rateLimit(env, clientIp(req) + "#assets", 3))) {
    return json({ error: "rate limited" }, 429);
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const prompts = (Array.isArray(body?.prompts) ? body.prompts : [])
    .filter((p) => typeof p === "string" && p.trim())
    .slice(0, MAX_BATCH_ASSETS)
    .map((p) => p.trim().slice(0, 500));
  if (!prompts.length) return json({ error: "no prompts" }, 400);

  // スタイルバイブルはカット間の一貫性のために全プロンプトへ同じ文言を足す
  const style = typeof body?.style === "string" ? body.style.trim().slice(0, 300) : "";
  const negative = typeof body?.negativePrompt === "string" ? body.negativePrompt.trim().slice(0, 300) : "";
  const steps = Number(body?.steps) >= 4 && Number(body?.steps) <= 8 ? Number(body.steps) : 6;

  // 翻訳(llm8b)は非ASCIIのプロンプトにだけ走るが、予算は安全側に多めで確保する
  const cost = prompts.length * (AI_COST.image + AI_COST.llm8b);
  if (!(await spendAiBudget(env, cost)).ok) return budgetExceeded();

  const assets = [];
  const errors = [];
  for (const [i, raw] of prompts.entries()) {
    try {
      const translated = await translatePrompt(ai, raw);
      const prompt = [translated, style].filter(Boolean).join(", ");
      const out = await ai.image({
        prompt: negative ? `${prompt} | negative: ${negative}` : prompt,
        steps,
      });
      assets.push({
        index: i,
        prompt,
        contentType: out.contentType,
        data: bytesToBase64(out.bytes),
      });
    } catch (e) {
      const msg = e?.message ?? String(e);
      console.error(`asset ${i} failed:`, msg);
      // 予算切れは以降も必ず失敗するので、そこで打ち切って部分結果を返す
      if (msg.includes("4006") || msg.includes("neurons")) {
        errors.push({ index: i, error: "quota exceeded" });
        break;
      }
      errors.push({ index: i, error: "generation failed" });
    }
  }

  // 1枚も作れなければ失敗として扱う。部分成功はそのまま返し、呼び出し側が
  // 足りないカットだけ再試行できるようにする
  if (!assets.length) return json({ error: "generation failed", errors }, 502);
  return json({ assets, errors, requested: prompts.length });
}

// 企画(brief)から絵コンテを起こす。カットの役割・尺・画の指示・演出・つなぎを決める。
// ここはJSONの設計だけを担当し、素材生成とタイムライン配置はクライアント/MCP側が行う。
const STORYBOARD_SYSTEM = [
  "You are a short-form video director. You turn a brief into a storyboard for NOIZ LAB.",
  "Reply with ONLY minified JSON. No code fences, no explanations.",
  'Schema: {"title":"短い日本語タイトル(20文字以内)","logline":"何の動画か1文(50文字以内)","cuts":[{"purpose":"hook|explain|demonstrate|reveal|emotion|cta","duration":seconds(0.5-6),"shot":"画の内容を1文で(60文字以内)","caption":"画面に出す字幕(20文字以内、空文字可)","imagePrompt":"画像生成用の英語プロンプト(装飾語込みで25語以内)","preset":"Y2K|VHS|DREAM|PRINT|PIXEL|SORTED|CINEMA|FILM|NEON","motion":"orthographic-pullback|constant-linear|frame-echo|stagger|modular-grid|match-cut|controlled-chaos","transitionOut":"fade|wipe|dissolve|glitch|punch|flash|push|film-burn|null"}]}',
  "The FIRST cut MUST be purpose hook and at most 2 seconds: the viewer decides in that time whether to keep watching.",
  "The LAST cut MUST have transitionOut null. Every other cut needs a transition.",
  "Vary the cut durations. Uniform lengths read as a slideshow, not a video.",
  "The sum of durations MUST be within 10% of the requested duration.",
  "Use 2-8 cuts. Fewer, longer cuts for a calm mood; more, shorter cuts for an energetic one.",
  "Keep one preset for the whole piece unless the brief asks for a visual turn; consistency reads as intent.",
  "captions must work with the sound off. Write them in the brief's language.",
  "imagePrompt is always English regardless of the brief language, and must describe a still image with no text in it.",
].join("\n");

async function storyboardRoute(req, env, ai) {
  if (!(await rateLimit(env, clientIp(req) + "#storyboard", 10))) {
    return json({ error: "rate limited" }, 429);
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const objective = body?.objective;
  if (typeof objective !== "string" || !objective.trim() || objective.length > 1000) {
    return json({ error: "invalid objective" }, 400);
  }
  const duration = Number(body?.duration) > 0 ? Math.min(180, Number(body.duration)) : 15;
  const platform = String(body?.platform ?? "generic").slice(0, 40);
  const audience = String(body?.audience ?? "").slice(0, 500);
  const mood = (Array.isArray(body?.mood) ? body.mood : [])
    .filter((m) => typeof m === "string" && m.trim())
    .slice(0, 8)
    .map((m) => m.slice(0, 80));
  const language = String(body?.language ?? "ja").slice(0, 16);

  const userMsg = [
    `Objective: ${objective.trim()}`,
    audience ? `Audience: ${audience}` : "Audience: unspecified",
    `Platform: ${platform}`,
    `Target duration: ${duration} seconds`,
    mood.length ? `Mood: ${mood.join(", ")}` : "Mood: unspecified",
    `Caption language: ${language}`,
  ].join("\n");

  if (!(await spendAiBudget(env, AI_COST.llm70b)).ok) return budgetExceeded();

  try {
    const raw = await ai.chat({
      system: STORYBOARD_SYSTEM,
      user: userMsg,
      maxTokens: 1200,
    });
    // モデル/ランタイムによりresponseが文字列でなくパース済みの場合がある
    const parsed = raw && typeof raw === "object" ? raw : extractJson(String(raw ?? ""));
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.cuts) || !parsed.cuts.length) {
      console.error("storyboard parse failed:", String(raw).slice(0, 200));
      return json({ error: "parse failed" }, 502);
    }
    // 上限だけ守らせる。個々の値の正規化は受け手(MCP/クライアント)が行う
    return json({ storyboard: { ...parsed, cuts: parsed.cuts.slice(0, 8) } });
  } catch (e) {
    const msg = e?.message ?? String(e);
    console.error("storyboard failed:", msg);
    if (msg.includes("4006") || msg.includes("neurons")) {
      return json({ error: "quota exceeded" }, 503);
    }
    return json({ error: "storyboard failed" }, 500);
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

// 配信時にHTMLへ手を入れる。
//  - og:url/og:image を実際に配信しているoriginの絶対URLに書き換える
//    （これによりfork先でも設定なしで正しいOGPになる）
//  - 計測タグが設定されていれば<head>の末尾に足す
function decorateHtml(res, origin, env) {
  if (!(res.headers.get("content-type") || "").includes("text/html")) return res;
  // HTMLRewriterはセレクタリスト(カンマ区切り)に対応しないため個別に登録する
  const absolutize = {
    element(el) {
      const c = el.getAttribute("content");
      if (c && c.startsWith("/")) el.setAttribute("content", origin + c);
    },
  };
  let rw = new HTMLRewriter()
    .on('meta[property="og:url"]', absolutize)
    .on('meta[property="og:image"]', absolutize)
    .on('meta[name="twitter:image"]', absolutize);
  const tags = analyticsTags(env);
  if (tags) {
    rw = rw.on("head", { element: (el) => el.append(tags, { html: true }) });
  }
  return rw.transform(res);
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
        JSON.stringify({
          ai: !!ai,
          gallery,
          aiProvider: ai?.name ?? "none",
          // 計測先が無い構成では、クライアントはイベントを一切送らない
          analytics: !!env.ANALYTICS,
        }),
        { headers: { "content-type": "application/json", "cache-control": "no-store" } }
      );
    }

    // クライアントからの利用イベント（許可リストのイベント名のみ受け付ける）
    if (pathname === "/api/event" && req.method === "POST") {
      return handleEvent(req, env);
    }

    if (pathname === "/api/generate" && req.method === "POST") {
      if (!ai) return disabled("ai");
      return tracked(env, req, "ai_image", handleGenerate(req, env, ai));
    }
    if (pathname === "/api/scene" && req.method === "POST") {
      if (!ai) return disabled("ai");
      return tracked(env, req, "ai_scene", sceneRoute(req, env, ai));
    }

    // 当日のAI使用量の確認用（消費0で現在値だけ読む）
    if (pathname === "/api/budget" && req.method === "GET") {
      if (!authed(req, env)) return json({ error: "unauthorized" }, 401);
      const b = await spendAiBudget(env, 0);
      return json({ used: b.used, cap: b.cap, freeAllocation: 10000 });
    }

    if (pathname === "/api/assets" && req.method === "POST") {
      if (!ai) return disabled("ai");
      return tracked(env, req, "ai_assets", assetsRoute(req, env, ai));
    }

    if (pathname === "/api/storyboard" && req.method === "POST") {
      if (!ai) return disabled("ai");
      return tracked(env, req, "ai_storyboard", storyboardRoute(req, env, ai));
    }

    if (pathname === "/api/suggest" && req.method === "POST") {
      if (!ai) return disabled("ai");
      return tracked(env, req, "ai_suggest", suggestRoute(req, env, ai));
    }

    if (pathname.startsWith("/api/works") && !gallery) return disabled("gallery");
    if (pathname === "/api/works" && req.method === "POST") {
      return tracked(env, req, "work_save", saveWork(req, env, ctx, ai));
    }
    if (pathname === "/api/works" && req.method === "GET") return listWorks(req, env);

    // 共有ページ（作品ごと・24時間で失効）
    const sm = pathname.match(/^\/w\/([0-9a-f-]{36})$/);
    if (sm && req.method === "GET" && gallery) {
      const meta = await sharedMeta(env, sm[1]);
      // 共有リンクが実際に開かれた回数。期限切れかどうかも分けて数える
      // （キャッシュに載る分は数えられないので、下限値として見る）
      trackEvent(env, req, "share_view", meta ? "ok" : "expired");
      return decorateHtml(await sharePage(sm[1], meta, url.origin, env), url.origin, env);
    }

    // AI生成画像の共有ページ（約1日で失効・アクセスキー不要）
    const asm = pathname.match(/^\/s\/([0-9a-f-]{36})$/);
    if (asm && req.method === "GET") {
      const page = await aiSharePage(env, asm[1], url.origin);
      trackEvent(env, req, "share_view", page.status === 410 ? "expired" : "ai");
      return decorateHtml(page, url.origin, env);
    }
    const asi = pathname.match(/^\/api\/shares\/([0-9a-f-]{36})\/image$/);
    if (asi && req.method === "GET") return aiShareImage(env, asi[1]);

    const m = pathname.match(/^\/api\/works\/([0-9a-f-]{36})(?:\/(source|thumb|og|embed|share|meta))?$/);
    if (m) {
      if (req.method === "GET" && (m[2] === "source" || m[2] === "thumb" || m[2] === "og")) {
        return getWorkImage(req, env, url, m[1], m[2]);
      }
      if (req.method === "POST" && m[2] === "embed") {
        if (!ai) return disabled("ai");
        return embedRoute(req, env, ai, m[1]);
      }
      if (req.method === "POST" && m[2] === "share") {
        return tracked(env, req, "work_share", shareWork(req, env, m[1]));
      }
      if (req.method === "GET" && m[2] === "meta") {
        const meta = await sharedMeta(env, m[1]);
        return meta ? json(meta) : json({ error: "not shared" }, 404);
      }
      if (req.method === "DELETE" && !m[2]) return deleteWork(req, env, m[1]);
    }

    // OGPの絶対URLはデプロイ先で変わるため、配信時にoriginを埋める
    return decorateHtml(await env.ASSETS.fetch(req), url.origin, env);
  },
};
