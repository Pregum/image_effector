#!/usr/bin/env node
// NOIZ LAB Webアプリの回帰テスト。
//
// public/ を一時ディレクトリへ複製し、app.js の末尾に location.hash で分岐する
// 検証コードを足して、headless Chrome で実際に描画させた結果を <title> から読む。
//
// ここで守っているのは、コードを読むだけでは気づけない類の壊れ方です。
//   - 配列uniformがシェーダへ届かず、全段が同じ処理になる
//   - module冒頭のTDZ（宣言前参照）で、それ以降のコードが丸ごと実行されない
//   - Project JSONの往復で編集内容が落ちる
//   - 字幕が書き出しキャンバスへ焼き込まれない
//
// 使い方: node scripts/test-web-app.mjs
// Chromeの場所は CHROME_BIN で上書きできます。見つからない環境ではスキップします。

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = join(ROOT, "public");

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

// 検証コード。ページ側（モジュールスコープ）で動くので、app.js の中身をそのまま触れる。
// 結果は document.title へ "OK|key=value|..." の形で書き出す。
const HARNESS = `
// ---- 回帰テスト用（scripts/test-web-app.mjs が末尾に足す。本番には入らない）----
(async () => {
  const CASE = new URLSearchParams(location.hash.slice(1)).get("t");
  if (!CASE) return;
  const out = [];
  const push = (k, v) => out.push(k + "=" + v);

  // 素材はダミーのBlobを渡す。--virtual-time-budget 下では canvas.toBlob が進まないため
  const dummy = () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" });
  const addCut = async () => {
    const c = document.createElement("canvas");
    c.width = originalData.width;
    c.height = originalData.height;
    c.getContext("2d").putImageData(originalData, 0, 0);
    await addSlideBitmap(await createImageBitmap(c), currentRecipe(), dummy());
  };
  const shot = (w = 64, h = 64) => {
    render(0);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, w, h);
    return x.getImageData(0, 0, w, h).data;
  };
  const rmse = (a, b) => {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
    return Math.sqrt(sum / a.length);
  };

  try {
    for (let i = 0; i < 60 && !originalData; i++) await new Promise((r) => setTimeout(r, 100));
    if (!originalData) throw new Error("サンプル画像が読み込まれなかった");
    push("boot", "ok"); // ここまで来た＝moduleが最後まで評価された

    if (CASE === "render") {
      // 適用順の配列uniformがシェーダへ届いているか。
      // 届いていないと全段が stage 0 として読まれ、順番を変えても絵が変わらない
      applyPreset(PRESETS.find((p) => p.name === "CINEMA"));
      const normal = shot();
      const st = { ...state, order: [8, 7, 6, 5, 4, 3, 2, 1, 0, 9] };
      const flipped = (() => {
        const keep = state.order;
        state.order = st.order;
        const px = shot();
        state.order = keep;
        return px;
      })();
      push("orderEffect", rmse(normal, flipped).toFixed(2));
      push("orderLen", colorOrder(state).length);
      // 旧レシピ（9段時代）の並び順が10段へ補完されるか
      push("migrate", Array.from(colorOrder({ order: [0, 1, 2, 3, 4, 5, 6, 7, 8] })).join(""));

      // パレット寄せ。参照色が実際に絵へ効いているか
      applyPreset(PRESETS[0]);
      const before = shot();
      stylePalette = [[255, 0, 0], [0, 0, 255]];
      enabled.palette = true;
      state.palMix = 1;
      push("palette", rmse(before, shot()).toFixed(2));
      stylePalette = [];
      enabled.palette = false;

      // MCPが書く {preset, ...} 形式のレシピを解決できるか
      const rr = resolveRecipe({ preset: "CINEMA", palette: ["#ff0000"], seed: 7 });
      push("resolve", [rr.enabled.grade, rr.state.split, rr.seed].join("/"));
    }

    if (CASE === "project") {
      for (let i = 0; i < 3; i++) await addCut();
      push("cuts", slides.length);
      // 字幕が無いうちはレビューが指摘する
      push("noCaption", reviewProject(buildProjectManifest()).findings.some((f) => f.code === "no-captions"));
      const texts = ["夏の終わりに全部捨てた", "理由は一つだけ", "見てほしい"];
      slides.forEach((s, i) => { s.caption = texts[i]; });
      document.getElementById("bible-negative").value = "文字、透かし";
      stylePalette = [[224, 58, 47], [28, 63, 191]];
      const m = buildProjectManifest();
      push("captions", m.captions.map((c) => c.cutIndex + ":" + c.text.length).join(","));
      push("hasCaption", reviewProject(m).findings.some((f) => f.code === "no-captions"));
      push("bible", m.styleBible.palette.join("") + "/" + m.styleBible.negativePrompt);
      push("valid", JSON.stringify(validateProject(m).errors || []));
      push("score", reviewProject(m).score >= 0);
      // 往復してもスタイルバイブルが戻るか
      stylePalette = [];
      applyStyleBibleObject(m.styleBible);
      push("restore", stylePalette.map(rgbToHex).join(""));
    }

    if (CASE === "caption") {
      for (let i = 0; i < 2; i++) await addCut();
      // プレビューは実時間で進むので、どのカットを見ていても字幕が出るよう全カットに入れる
      slides[0].caption = "無音でも伝わる一言";
      slides[1].caption = "次のカットにも字幕";
      const s0 = seqAt(0, slides.length, seqState.hold * 1000, seqState.trans * 1000, seqState.zoom);
      seqFrame = {
        texA: slides[s0.a].tex, texB: slides[s0.b].tex, t: s0.t,
        zoomA: s0.zoomA, zoomB: s0.zoomB, motA: s0.motA, motB: s0.motB,
        surfA: s0.surfA, surfB: s0.surfB, mode: s0.mode, connect: s0.connect, anchor: s0.anchor,
      };
      seqOverride = overrideFor(s0.a, s0.b, s0.t);
      render(0);
      // GIF書き出しと同じ経路。字幕は出力用の2Dキャンバスへ焼き込まれる
      const oc = document.createElement("canvas");
      oc.width = 480; oc.height = 320;
      const octx = oc.getContext("2d", { willReadFrequently: true });
      octx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, 480, 320);
      const bandBefore = octx.getImageData(0, 250, 480, 60).data.slice();
      drawCaption(octx, 480, 320, captionAt(s0));
      push("burnIn", rmse(bandBefore, octx.getImageData(0, 250, 480, 60).data).toFixed(2));
      // 長い字幕でも2行に収まる
      push("wrap", wrapCaption(octx, "あ".repeat(120), 400).length);
      // 動画プレビュー中は字幕がcanvasの上に重なる
      setPreviewMode(true);
      await new Promise((r) => setTimeout(r, 500));
      const pv = document.getElementById("caption-preview");
      push("overlay", (!pv.hidden) + ":" + slides.some((s) => s.caption === pv.textContent));
      setPreviewMode(false);
    }

    document.title = "OK|" + out.join("|");
  } catch (e) {
    document.title = "ERR|" + (e && e.message ? e.message : e) + "|" + out.join("|");
  }
})();
`;

function findChrome() {
  return CHROME_CANDIDATES.find((p) => existsSync(p)) || null;
}

async function serveDir(dir) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = join(dir, normalize(path).replace(/^(\.\.[/\\])+/, ""));
    const target = file.endsWith("/") ? join(file, "index.html") : file;
    try {
      const body = await readFile(target);
      res.writeHead(200, { "content-type": MIME[extname(target)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

// --dump-dom は仮想時間の予算を使い切った時点のDOMを出す。
// 検証コードは結果を <title> に書くので、そこだけ読めばよい。
function runChrome(chrome, url, budgetMs) {
  return new Promise((resolve, reject) => {
    const args = [
      "--headless=new", "--disable-gpu-sandbox", "--use-angle=swiftshader",
      "--no-sandbox", "--hide-scrollbars", "--mute-audio",
      `--virtual-time-budget=${budgetMs}`, "--dump-dom", url,
    ];
    const child = spawn(chrome, args, { stdio: ["ignore", "pipe", "ignore"] });
    let dom = "";
    child.stdout.on("data", (c) => { dom += c; });
    child.on("error", reject);
    child.on("close", () => {
      const m = /<title>([^<]*)<\/title>/.exec(dom);
      resolve(m ? m[1] : "");
    });
  });
}

function parseTitle(title) {
  if (!title.startsWith("OK|")) return { ok: false, raw: title, fields: {} };
  const fields = {};
  for (const part of title.split("|").slice(1)) {
    const i = part.indexOf("=");
    if (i > 0) fields[part.slice(0, i)] = part.slice(i + 1);
  }
  return { ok: true, raw: title, fields };
}

const failures = [];
function check(name, condition, detail) {
  if (condition) console.log(`  ✓ ${name}${detail ? ` (${detail})` : ""}`);
  else {
    console.log(`  ✗ ${name}${detail ? ` (${detail})` : ""}`);
    failures.push(name);
  }
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.log("Chromeが見つからないためスキップします（CHROME_BIN で場所を指定できます）");
    return;
  }

  const work = await mkdtemp(join(tmpdir(), "noizlab-webtest-"));
  try {
    await cp(PUBLIC_DIR, work, { recursive: true });
    // moduleが評価中に落ちると <title> が変わらないままになる。原因が分かるよう捕まえる
    const html = (await readFile(join(work, "index.html"), "utf8")).replace(
      '<script type="module" src="./app.js"></script>',
      '<script>window.addEventListener("error", (e) => {'
      + 'document.title = "ERR|" + (e.message || "") + " @" + (e.filename || "").split("/").pop() + ":" + e.lineno;'
      + '}, true);</script>\n<script type="module" src="./app.js"></script>',
    );
    await writeFile(join(work, "index.html"), html);
    await writeFile(join(work, "app.js"), (await readFile(join(work, "app.js"), "utf8")) + HARNESS);

    const { port, close } = await serveDir(work);
    const base = `http://127.0.0.1:${port}/`;
    try {
      // --- 描画とuniform ---
      console.log("描画・uniform");
      const render = parseTitle(await runChrome(chrome, `${base}#t=render`, 30000));
      check("moduleが最後まで評価される", render.ok, render.ok ? "" : render.raw);
      if (render.ok) {
        const f = render.fields;
        check("適用順の配列uniformがシェーダへ届く", Number(f.orderEffect) > 0.5, `RMSE ${f.orderEffect}`);
        check("色処理は10段", f.orderLen === "10", f.orderLen);
        check("旧9段のレシピが10段へ補完される", f.migrate === "0123456789", f.migrate);
        check("パレット寄せが絵に効く", Number(f.palette) > 1, `RMSE ${f.palette}`);
        check("MCP形式のレシピを解決できる", f.resolve === "true/0.75/7", f.resolve);
      }

      // --- プロジェクトとレビュー ---
      console.log("プロジェクト・レビュー");
      const project = parseTitle(await runChrome(chrome, `${base}#t=project`, 45000));
      check("カットを積める", project.ok, project.ok ? "" : project.raw);
      if (project.ok) {
        const f = project.fields;
        check("3カット並ぶ", f.cuts === "3", f.cuts);
        check("字幕が無いとレビューが指摘する", f.noCaption === "true", f.noCaption);
        check("字幕を入れると指摘が消える", f.hasCaption === "false", f.hasCaption);
        check("字幕がProject JSONへ入る", f.captions === "0:11,1:7,2:5", f.captions);
        check("スタイルバイブルが書き出される", f.bible === "#e03a2f#1c3fbf/文字、透かし", f.bible);
        check("Project JSONが妥当", f.valid === "[]", f.valid);
        check("往復でパレットが戻る", f.restore === "#e03a2f#1c3fbf", f.restore);
      }

      // --- 字幕の焼き込み ---
      console.log("字幕");
      const caption = parseTitle(await runChrome(chrome, `${base}#t=caption`, 45000));
      check("字幕の経路が動く", caption.ok, caption.ok ? "" : caption.raw);
      if (caption.ok) {
        const f = caption.fields;
        check("書き出しキャンバスへ焼き込まれる", Number(f.burnIn) > 1, `RMSE ${f.burnIn}`);
        check("長い字幕は2行に収まる", f.wrap === "2", f.wrap);
        check("プレビューに字幕が重なる", f.overlay === "true:true", f.overlay);
      }
    } finally {
      await close();
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`\nNOIZ LAB web app tests FAILED: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\nNOIZ LAB web app tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
