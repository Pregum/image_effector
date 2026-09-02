#!/usr/bin/env node

import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const PRESETS = ["RESET", "Y2K", "VHS", "DREAM", "PRINT", "PIXEL", "SORTED", "CINEMA", "FILM", "NEON"];
const RATIOS = { original: "0", "16:9": "1.77778", square: "1", "1:1": "1", "9:16": "0.5625" };
const TRANSITIONS = ["fade", "wipe", "dissolve", "glitch", "punch", "flash", "push", "film-burn"];

function usage(code = 0) {
  console.log(`Usage:
  node scripts/noizlab-effect.mjs <input> <output.png> [options]
  node scripts/noizlab-effect.mjs --video <input...> <output.mp4> [options]

Options:
  --preset <name>    ${PRESETS.join(" | ")} (default: CINEMA)
  --ratio <ratio>    original | 16:9 | square | 1:1 | 9:16 (default: original)
  --text <text>      Add title text. Use | for a line break.
  --caption <text>   Per-cut captions for --video. Use | to separate cuts.
  --palette <image>  Style bible reference: pull its colors and lock every cut to them
  --palette-mix <n>  How hard to pull toward the palette, 0-1 (default: 0.35)
  --gif              Export an animated GIF instead of MP4 (video mode, images only)
  --video            Build a transition video from 2-8 input images
  --transition <t>   ${TRANSITIONS.join(" | ")} (default: glitch)
  --hold <seconds>   Time each image stays visible, 0.3-3 (default: 1.4)
  --duration <sec>   Transition duration, 0.2-2 (default: 0.8)
  --no-zoom          Disable the alternating Ken Burns zoom
  --chrome <path>    Chrome/Chromium executable path
  --list-presets     Print available presets
  -h, --help         Show this help

Example:
  node scripts/noizlab-effect.mjs photo.jpg out.png --preset FILM --text "夏の終わり|1999"
  node scripts/noizlab-effect.mjs --video 1.png 2.png 3.png ending.mp4 --preset FILM --ratio 16:9 --transition dissolve
  node scripts/noizlab-effect.mjs --video 1.png 2.png 3.png demo.gif --gif --palette ref.png --caption "夏の終わり|全部捨てた|見てほしい"`);
  process.exit(code);
}

function parseArgs(argv) {
  const positional = [];
  const opts = {
    preset: "CINEMA", ratio: "original", text: "", chrome: "",
    video: false, transition: "glitch", hold: 1.4, duration: 0.8, zoom: true,
    caption: "", palette: "", paletteMix: "", gif: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") usage();
    if (arg === "--video") { opts.video = true; continue; }
    if (arg === "--gif") { opts.gif = true; continue; }
    if (arg === "--no-zoom") { opts.zoom = false; continue; }
    if (arg === "--list-presets") {
      console.log(PRESETS.join("\n"));
      process.exit(0);
    }
    if (["--preset", "--ratio", "--text", "--chrome", "--transition", "--hold", "--duration", "--caption", "--palette", "--palette-mix"].includes(arg)) {
      if (argv[i + 1] == null) throw new Error(`${arg} requires a value`);
      // --palette-mix のようなケバブ記法を camelCase の名前へ揃える
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      opts[key] = argv[++i];
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    positional.push(arg);
  }
  if ((!opts.video && positional.length !== 2) || (opts.video && (positional.length < 3 || positional.length > 9))) usage(1);
  opts.inputs = (opts.video ? positional.slice(0, -1) : positional.slice(0, 1)).map((p) => resolve(p));
  opts.input = opts.inputs[0];
  opts.output = resolve(positional.at(-1));
  opts.preset = opts.preset.toUpperCase();
  if (!PRESETS.includes(opts.preset)) throw new Error(`Unknown preset: ${opts.preset}`);
  if (!(opts.ratio in RATIOS)) throw new Error(`Unknown ratio: ${opts.ratio}`);
  for (const input of opts.inputs) {
    if (!existsSync(input)) throw new Error(`Input file not found: ${input}`);
  }
  if (opts.palette && !existsSync(opts.palette)) throw new Error(`Palette reference not found: ${opts.palette}`);
  if (opts.paletteMix !== "") {
    const mix = Number(opts.paletteMix);
    if (!(mix >= 0 && mix <= 1)) throw new Error("--palette-mix must be between 0 and 1");
  }
  if (opts.gif && !opts.video) throw new Error("--gif needs --video");
  const outExt = extname(opts.output).toLowerCase();
  if (!opts.video && outExt !== ".png") throw new Error("Image output must end in .png");
  if (opts.video && opts.gif && outExt !== ".gif") throw new Error("GIF output must end in .gif");
  if (opts.video && !opts.gif && ![".mp4", ".webm"].includes(outExt)) throw new Error("Video output must end in .mp4 or .webm");
  if (!TRANSITIONS.includes(opts.transition)) {
    throw new Error(`Unknown transition: ${opts.transition}`);
  }
  opts.hold = Number(opts.hold);
  opts.duration = Number(opts.duration);
  if (!(opts.hold >= 0.3 && opts.hold <= 3)) throw new Error("--hold must be between 0.3 and 3");
  if (!(opts.duration >= 0.2 && opts.duration <= 2)) throw new Error("--duration must be between 0.2 and 2");
  return opts;
}

function findChrome(explicit) {
  const candidates = [
    explicit,
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    process.platform === "win32" && join(process.env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe"),
  ].filter(Boolean);
  const found = candidates.find(existsSync);
  if (!found) throw new Error("Chrome/Chromium was not found. Install it or pass --chrome <path>.");
  return found;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

async function startServer() {
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    if (pathname === "/api/config") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ai":false,"gallery":false,"analytics":false}');
      return;
    }
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const file = resolve(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + "/")) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (!(await stat(file)).isFile()) throw new Error("not a file");
      res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404).end("Not found");
    }
  });
  await new Promise((ok, fail) => server.listen(0, "127.0.0.1", ok).once("error", fail));
  return { server, port: server.address().port };
}

const delay = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function waitFor(fn, label, timeout = 20_000) {
  const until = Date.now() + timeout;
  let lastError;
  while (Date.now() < until) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
  }
  async open() {
    await new Promise((ok, fail) => {
      this.ws.addEventListener("open", ok, { once: true });
      this.ws.addEventListener("error", () => fail(new Error("Could not connect to Chrome DevTools")), { once: true });
    });
    this.ws.addEventListener("message", ({ data }) => {
      const msg = JSON.parse(data);
      if (!msg.id || !this.pending.has(msg.id)) return;
      const { ok, fail } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) fail(new Error(msg.error.message));
      else ok(msg.result);
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((ok, fail) => {
      this.pending.set(id, { ok, fail });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.ws.close(); }
}

async function evalJs(cdp, expression, returnByValue = true) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Browser evaluation failed");
  return returnByValue ? result.result.value : result.result;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const chrome = findChrome(opts.chrome);
  if (typeof WebSocket === "undefined") throw new Error("Node.js 22 or newer is required.");

  await mkdir(dirname(opts.output), { recursive: true });
  const work = await mkdtemp(join(tmpdir(), "noizlab-cli-"));
  const downloads = join(work, "downloads");
  const profile = join(work, "chrome-profile");
  await mkdir(downloads);
  const { server, port } = await startServer();
  const debugPort = 9200 + (parseInt(createHash("sha1").update(work).digest("hex").slice(0, 4), 16) % 2000);
  const child = spawn(chrome, [
    "--headless=new",
    "--enable-unsafe-swiftshader",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: "ignore" });

  let cdp;
  try {
    const targets = await waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      return res.ok ? res.json() : null;
    }, "Chrome startup");
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("Chrome did not create a page target");
    cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("DOM.enable");
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });

    const url = `http://127.0.0.1:${port}/#preset=${encodeURIComponent(opts.preset)}`;
    await cdp.send("Page.navigate", { url });
    await waitFor(() => evalJs(cdp, "document.readyState === 'complete' && !!document.getElementById('file-input')"), "NOIZ LAB startup");

    const input = await evalJs(cdp, "document.getElementById('file-input')", false);
    await cdp.send("DOM.setFileInputFiles", { files: [opts.input], objectId: input.objectId });
    await waitFor(() => evalJs(cdp, "document.getElementById('status-res').textContent.trim() !== '—'"), "image load");

    await evalJs(cdp, `(() => {
      const anim = document.getElementById('chk-anim');
      if (anim.checked) anim.click();
      const ratio = ${JSON.stringify(RATIOS[opts.ratio])};
      document.querySelector('#ratio-seg button[data-r="' + ratio + '"]').click();
      const text = document.getElementById('text-input');
      text.value = ${JSON.stringify(opts.text.slice(0, 60))};
      text.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    if (opts.palette) {
      const ref = await evalJs(cdp, "document.getElementById('bible-ref-input')", false);
      await cdp.send("DOM.setFileInputFiles", { files: [resolve(opts.palette)], objectId: ref.objectId });
      await waitFor(
        () => evalJs(cdp, "document.getElementById('bible-swatches').children.length > 0"),
        "style bible palette",
      );
      if (opts.paletteMix !== "") {
        await evalJs(cdp, `(() => {
          const slider = document.querySelector('[data-id="palette"] input[type="range"]');
          slider.value = ${JSON.stringify(opts.paletteMix)};
          slider.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()`);
      }
    }
    await delay(500);
    if (opts.video) {
      await evalJs(cdp, "document.getElementById('slide-add').click(); true");
      await waitFor(() => evalJs(cdp, "document.querySelectorAll('.slide-item').length === 1"), "first video cut");
      for (let i = 1; i < opts.inputs.length; i++) {
        const before = i;
        const extra = await evalJs(cdp, "document.getElementById('transb-input')", false);
        await cdp.send("DOM.setFileInputFiles", { files: [opts.inputs[i]], objectId: extra.objectId });
        await waitFor(
          () => evalJs(cdp, `document.querySelectorAll('.slide-item').length === ${before + 1}`),
          `video cut ${i + 1}`,
        );
      }
      const captions = opts.caption ? opts.caption.split("|") : [];
      for (let i = 0; i < captions.length && i < opts.inputs.length; i++) {
        await evalJs(cdp, `(() => {
          document.querySelectorAll('.slide-item img')[${i}].click();
          const el = document.getElementById('caption-input');
          el.value = ${JSON.stringify(captions[i].slice(0, 60))};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()`);
      }
      await evalJs(cdp, `(() => {
        const mode = ${JSON.stringify(TRANSITIONS.indexOf(opts.transition))};
        document.querySelector('#trans-mode-seg button[data-mode="' + mode + '"]').click();
        const hold = document.getElementById('slide-hold');
        hold.value = ${JSON.stringify(opts.hold)};
        hold.dispatchEvent(new Event('input', { bubbles: true }));
        const duration = document.getElementById('trans-duration');
        duration.value = ${JSON.stringify(opts.duration)};
        duration.dispatchEvent(new Event('input', { bubbles: true }));
        const zoom = document.getElementById('chk-zoom');
        if (zoom.checked !== ${JSON.stringify(opts.zoom)}) zoom.click();
        document.getElementById(${JSON.stringify(opts.gif ? "btn-gif" : "btn-transition")}).click();
        return true;
      })()`);
      const wanted = opts.gif ? /\.gif$/i : /\.(mp4|webm)$/i;
      const downloaded = await waitFor(async () => {
        const files = await readdir(downloads);
        return files.find((name) => wanted.test(name)) || null;
      }, opts.gif ? "GIF export" : "video export", 180_000);
      const actualExt = extname(downloaded).toLowerCase();
      const requestedExt = extname(opts.output).toLowerCase();
      const finalOutput = actualExt === requestedExt
        ? opts.output
        : opts.output.slice(0, -requestedExt.length) + actualExt;
      await rename(join(downloads, downloaded), finalOutput);
      const extras = [
        opts.palette ? "palette-locked" : "",
        opts.caption ? "captioned" : "",
      ].filter(Boolean).join(", ");
      console.log(`Created ${finalOutput} (${opts.inputs.length} cuts, ${opts.transition}, ${opts.preset}, ${opts.ratio}${extras ? `, ${extras}` : ""})`);
    } else {
      await evalJs(cdp, "document.getElementById('btn-save').click(); true");
      const downloaded = await waitFor(async () => {
        const files = await readdir(downloads);
        return files.find((name) => name.endsWith(".png")) || null;
      }, "PNG export", 30_000);
      await rename(join(downloads, downloaded), opts.output);
      console.log(`Created ${opts.output} (${opts.preset}, ${opts.ratio})`);
    }
  } finally {
    cdp?.close();
    if (child.exitCode === null) {
      const exited = new Promise((ok) => child.once("exit", ok));
      child.kill("SIGTERM");
      await Promise.race([exited, delay(2_000)]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await Promise.race([exited, delay(2_000)]);
      }
    }
    await new Promise((ok) => server.close(ok));
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(`noizlab-effect: ${error.message}`);
  process.exitCode = 1;
});
