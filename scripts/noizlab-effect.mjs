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

function usage(code = 0) {
  console.log(`Usage:
  node scripts/noizlab-effect.mjs <input> <output.png> [options]

Options:
  --preset <name>    ${PRESETS.join(" | ")} (default: CINEMA)
  --ratio <ratio>    original | 16:9 | square | 1:1 | 9:16 (default: original)
  --text <text>      Add title text. Use | for a line break.
  --chrome <path>    Chrome/Chromium executable path
  --list-presets     Print available presets
  -h, --help         Show this help

Example:
  node scripts/noizlab-effect.mjs photo.jpg out.png --preset FILM --text "夏の終わり|1999"`);
  process.exit(code);
}

function parseArgs(argv) {
  const positional = [];
  const opts = { preset: "CINEMA", ratio: "original", text: "", chrome: "" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") usage();
    if (arg === "--list-presets") {
      console.log(PRESETS.join("\n"));
      process.exit(0);
    }
    if (["--preset", "--ratio", "--text", "--chrome"].includes(arg)) {
      if (argv[i + 1] == null) throw new Error(`${arg} requires a value`);
      opts[arg.slice(2)] = argv[++i];
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    positional.push(arg);
  }
  if (positional.length !== 2) usage(1);
  opts.input = resolve(positional[0]);
  opts.output = resolve(positional[1]);
  opts.preset = opts.preset.toUpperCase();
  if (!PRESETS.includes(opts.preset)) throw new Error(`Unknown preset: ${opts.preset}`);
  if (!(opts.ratio in RATIOS)) throw new Error(`Unknown ratio: ${opts.ratio}`);
  if (!existsSync(opts.input)) throw new Error(`Input file not found: ${opts.input}`);
  if (extname(opts.output).toLowerCase() !== ".png") throw new Error("Output must end in .png");
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
    await delay(500);
    await evalJs(cdp, "document.getElementById('btn-save').click(); true");

    const downloaded = await waitFor(async () => {
      const files = await readdir(downloads);
      return files.find((name) => name.endsWith(".png")) || null;
    }, "PNG export", 30_000);
    await rename(join(downloads, downloaded), opts.output);
    console.log(`Created ${opts.output} (${opts.preset}, ${opts.ratio})`);
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
