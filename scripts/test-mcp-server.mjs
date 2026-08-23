#!/usr/bin/env node
// Exercises the MCP tool logic directly and the JSON-RPC layer over a real
// stdio subprocess, so a protocol regression fails here rather than in a client.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateProject } from "../public/project-format.js";
import { createServer } from "node:http";
import {
  ToolError, applyStyleBible, buildShortVideo, createProjectFromBrief,
  generateStoryboard, renderProject, reviewHookAndPacing,
} from "../mcp/tools.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "mcp/server.mjs");

const throws = (fn, pattern, label) => assert.throws(fn, (e) => {
  assert.ok(e instanceof ToolError, `${label}: expected ToolError, got ${e.constructor.name}`);
  assert.match(e.message, pattern, label);
  return true;
});

// --- create_project_from_brief ---------------------------------------------

const brief = createProjectFromBrief({
  objective: "新しいメモアプリを15秒で紹介したい",
  audience: "個人開発者",
  platform: "youtube-shorts",
  duration: 15,
  mood: ["ネオン", "夜"],
});
assert.deepEqual(validateProject(brief.project), { valid: true, errors: [] });
assert.equal(brief.project.brief.platform, "youtube-shorts");
assert.equal(brief.project.canvas.ratio, "9:16", "vertical platform must pick a 9:16 canvas");
assert.equal(brief.project.render.width, 720);
assert.equal(brief.plan.preset, "NEON", "mood keywords should select a preset");
assert.equal(brief.plan.cuts[0].purpose, "hook");
assert.equal(brief.plan.cutCount, brief.plan.cuts.length);
// The hook is shortened and the surplus moved to the last cut, so the plan must
// still add up to the requested duration.
assert.equal(brief.plan.totalDuration, 15, "cut plan must preserve the requested duration");
assert.ok(brief.plan.cuts[0].duration < brief.plan.cuts.at(-1).duration, "hook should be shorter than the closer");

assert.equal(createProjectFromBrief({ objective: "夏の終わりのVHS風", duration: 8 }).plan.preset, "VHS");
assert.equal(createProjectFromBrief({ objective: "何かいい感じに" }).plan.preset, "CINEMA", "unmatched moods fall back to CINEMA");
throws(() => createProjectFromBrief({}), /objective/, "objective is required");
throws(() => createProjectFromBrief({ objective: "x", platform: "myspace" }), /platform must be one of/, "unknown platform");
throws(
  () => createProjectFromBrief({ objective: "x", platform: "youtube-shorts", duration: 120 }),
  /at most 60s/,
  "duration over the platform limit",
);

// --- apply_style_bible ------------------------------------------------------

const styled = applyStyleBible({
  project: brief.project,
  styleBible: { preset: "NEON", palette: ["#ff00aa", "#00e5ff"], lighting: "夜のネオン", seed: 42 },
});
assert.deepEqual(styled.project.styleBible.palette, ["#ff00aa", "#00e5ff"]);
assert.equal(styled.project.styleBible.seed, 42);
assert.equal(styled.project.styleBible.lighting, "夜のネオン");
assert.equal(styled.project.editor.recipe.preset, "NEON");
assert.equal(styled.updatedCuts, 0, "no clips yet, so nothing to stamp");
// Unspecified fields keep their previous value rather than being cleared.
assert.equal(styled.project.styleBible.negativePrompt, brief.project.styleBible.negativePrompt);
throws(
  () => applyStyleBible({ project: brief.project, styleBible: { palette: ["red"] } }),
  /#rrggbb/,
  "palette must be hex",
);
throws(
  () => applyStyleBible({ project: { format: "nope" }, styleBible: {} }),
  /not a valid NOIZ LAB project/,
  "invalid project is rejected up front",
);

// --- build_short_video ------------------------------------------------------

const frames = ["01-friction.jpg", "02-idea.jpg", "03-making.jpg", "04-dawn.jpg"]
  .map((name) => join(ROOT, "docs/pizza-ai-tooling-lt/ai-frames", name));

const built = buildShortVideo({
  project: styled.project,
  assets: frames.map((path) => ({ path, type: "image" })),
  duration: 12,
  transitions: ["fade", "glitch"],
});
assert.deepEqual(validateProject(built.project), { valid: true, errors: [] });
assert.equal(built.summary.cuts, 4);
assert.equal(built.project.assets.length, 4);
assert.equal(built.project.assets[0].source.kind, "local");
assert.equal(built.project.assets[0].mime, "image/jpeg", "mime is inferred from the extension");
const clips = built.project.timeline.tracks[0].clips;
assert.equal(clips[0].purpose, "hook");
assert.equal(clips.at(-1).purpose, "cta");
assert.equal(clips.at(-1).transitionOut, null, "the last cut has nothing to transition into");
assert.deepEqual(clips.slice(0, -1).map((c) => c.transitionOut.technique), ["fade", "glitch", "fade"], "transitions cycle");
// Clips must be laid end to end: each start equals the sum of prior durations.
let cursor = 0;
for (const clip of clips) {
  assert.equal(clip.start, Number(cursor.toFixed(3)), "clips must be contiguous");
  cursor += clip.duration;
}
assert.equal(clips[0].recipe.preset, "NEON", "cuts inherit the style bible preset");

// BPM snapping: at 120bpm with beatDivision 2 a beat-pair is 1s, so a 4-cut
// 12s request (3s each) snaps to a whole number of seconds.
const snapped = buildShortVideo({
  project: styled.project,
  assets: frames.map((path) => ({ path })),
  duration: 12,
  bpm: 120,
  beatDivision: 2,
});
assert.equal(snapped.summary.beatSnapped, true);
assert.equal(snapped.summary.hold % 1, 0, "hold should land on the beat grid");

// The render pipeline can only hold a still for 0.3-3s, so a long duration over
// few cuts cannot be honoured. It must say so rather than quietly running short.
const clampedBuild = buildShortVideo({
  project: styled.project,
  assets: frames.map((path) => ({ path })),
  duration: 30,
});
assert.ok(clampedBuild.summary.note, "a clamped hold must be reported");
assert.equal(clampedBuild.summary.requestedDuration, 30);
assert.ok(clampedBuild.summary.totalDuration < 30);
assert.equal(built.summary.note, undefined, "an achievable duration needs no note");
assert.equal(
  built.summary.totalDuration,
  built.project.timeline.tracks[0].clips.reduce((sum, c) => sum + c.duration, 0),
  "the reported runtime must match the timeline",
);

throws(() => buildShortVideo({ project: styled.project }), /at least one item/, "no assets at all");
throws(
  () => buildShortVideo({ project: styled.project, assets: frames.map((p) => ({ path: p })), transitions: ["swirl"] }),
  /transitions\[0\] must be one of/,
  "unknown transition",
);
throws(
  () => buildShortVideo({
    project: styled.project,
    assets: Array.from({ length: 9 }, () => ({ path: frames[0] })),
  }),
  /at most 8 cuts/,
  "too many cuts",
);

// --- generate_storyboard ----------------------------------------------------

// A caller-written storyboard: the MCP client is itself an LLM, so this path
// works with no backend at all.
const handWritten = {
  title: "夜のメモアプリ",
  logline: "深夜に書きなぐるためのメモアプリ",
  cuts: [
    { purpose: "hook", duration: 1.5, shot: "暗い机", caption: "深夜2時", imagePrompt: "dark desk at night", preset: "NEON", motion: "frame-echo", transitionOut: "glitch" },
    { purpose: "demonstrate", duration: 4, shot: "入力", caption: "開いて即入力", imagePrompt: "typing on a laptop", preset: "NEON", motion: "modular-grid", transitionOut: "fade" },
    { purpose: "cta", duration: 4, shot: "ロゴ", caption: "今すぐ", imagePrompt: "app logo glowing", preset: "NEON", motion: "match-cut", transitionOut: "dissolve" },
  ],
};

const boardOnly = await generateStoryboard({ storyboard: handWritten, duration: 9, language: "ja" });
assert.equal(boardOnly.source, "caller");
assert.equal(boardOnly.project, undefined, "without a project only the storyboard comes back");
assert.equal(boardOnly.storyboard.cuts.length, 3);
assert.equal(boardOnly.storyboard.totalDuration, 9, "cuts are rescaled to the requested duration");
assert.equal(boardOnly.storyboard.cuts.at(-1).transitionOut, null, "the last cut must not transition");
assert.equal(boardOnly.storyboard.cuts[0].transitionOut, "glitch");

// Rescaling: the same board asked for 15s must still sum to 15s.
const rescaled = await generateStoryboard({ storyboard: handWritten, duration: 15 });
assert.equal(rescaled.storyboard.totalDuration, 15);

// The hook is the one cut whose length is deliberate — it has to land in about
// two seconds. Stretching it to fill a longer target defeats the storyboard, so
// a short hook is held and the other cuts absorb the change.
{
  const board = {
    cuts: [
      { purpose: "hook", duration: 1.8, transitionOut: "glitch" },
      { purpose: "demonstrate", duration: 6.5, transitionOut: "fade" },
      { purpose: "cta", duration: 6.7, transitionOut: null },
    ],
  };
  const grown = await generateStoryboard({ storyboard: board, duration: 9 });
  assert.equal(grown.storyboard.cuts[0].duration, 1.8, "a short hook survives rescaling");
  assert.equal(grown.storyboard.totalDuration, 9);

  // Protection is preferred, not absolute: when every other cut is already at
  // the 6s ceiling, releasing the hook beats silently missing the target.
  const forced = await generateStoryboard({ storyboard: board, duration: 18 });
  assert.equal(forced.storyboard.totalDuration, 18, "an achievable target must be hit");
  assert.ok(forced.storyboard.cuts[0].duration > 1.8, "the hook is released when nothing else has headroom");

  // A hook that was already long is not protected.
  const longHook = await generateStoryboard({
    storyboard: { cuts: [{ purpose: "hook", duration: 5, transitionOut: "fade" }, { purpose: "cta", duration: 5, transitionOut: null }] },
    duration: 6,
  });
  assert.equal(longHook.storyboard.totalDuration, 6);
  assert.equal(longHook.storyboard.cuts[0].duration, 3, "a long hook rescales like any other cut");

  // A target below the structural minimum cannot be met; it must stay honest
  // rather than inventing sub-0.5s cuts, and totalDuration shows the truth.
  const tooShort = await generateStoryboard({ storyboard: board, duration: 1 });
  assert.equal(tooShort.storyboard.totalDuration, 1.5, "3 cuts cannot go below 0.5s each");
  assert.ok(tooShort.storyboard.cuts.every((c) => c.duration >= 0.5));
}

// Junk fields are repaired rather than rejected, so one bad value does not throw
// away an otherwise usable storyboard.
const messy = await generateStoryboard({
  storyboard: {
    cuts: [
      { purpose: "nonsense", duration: 999, preset: "NOT_A_PRESET", motion: "wiggle", transitionOut: "teleport" },
      { duration: -5 },
    ],
  },
  duration: 6,
});
assert.equal(messy.storyboard.cuts[0].purpose, "hook", "an unknown purpose falls back by position");
assert.equal(messy.storyboard.cuts[0].preset, null, "an unknown preset is dropped, not guessed");
assert.equal(messy.storyboard.cuts[0].motion, "orthographic-pullback");
assert.equal(messy.storyboard.cuts[0].transitionOut, "fade", "an unknown transition falls back");
assert.ok(messy.storyboard.cuts.every((c) => c.duration >= 0.5 && c.duration <= 6), "durations are clamped");
assert.equal(messy.storyboard.cuts.at(-1).purpose, "cta");

// Folding a storyboard into a project pulls in captions and the preset.
const briefForBoard = createProjectFromBrief({ objective: "メモアプリ紹介", platform: "youtube-shorts", duration: 9 });
const folded = await generateStoryboard({ project: briefForBoard.project, storyboard: handWritten, duration: 9 });
assert.equal(folded.project.title, "夜のメモアプリ", "the storyboard title wins by default");
assert.equal(folded.project.captions.length, 3, "captions come across");
assert.equal(folded.project.captions[0].text, "深夜2時");
assert.equal(folded.project.editor.recipe.preset, "NEON", "the dominant preset is adopted");
assert.deepEqual(validateProject(folded.project), { valid: true, errors: [] });

const keptTitle = await generateStoryboard({
  project: briefForBoard.project, storyboard: handWritten, duration: 9, keepTitle: true,
});
assert.equal(keptTitle.project.title, briefForBoard.project.title, "keepTitle preserves the project name");

await assert.rejects(
  () => generateStoryboard({ storyboard: { cuts: [] }, duration: 5 }),
  /at least one cut/,
  "an empty storyboard is rejected",
);
await assert.rejects(
  () => generateStoryboard({ objective: "x" }),
  /pass storyboard .* or endpoint/,
  "one of storyboard or endpoint is required",
);
await assert.rejects(
  () => generateStoryboard({ objective: "x", endpoint: "not a url" }),
  /not a valid URL/,
  "a malformed endpoint is caught before fetching",
);
await assert.rejects(
  () => generateStoryboard({ objective: "x", endpoint: "file:///etc/passwd" }),
  /must be http or https/,
  "non-http endpoints are refused",
);

// The endpoint path, against a stub standing in for the Worker.
{
  const stub = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const sent = JSON.parse(body);
      if (req.url !== "/api/storyboard") { res.writeHead(404).end("{}"); return; }
      res.writeHead(200, { "content-type": "application/json" });
      // Echo the objective back so the test can prove the brief was forwarded.
      res.end(JSON.stringify({ storyboard: { title: sent.objective, cuts: handWritten.cuts } }));
    });
  });
  await new Promise((ok) => stub.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${stub.address().port}`;
  try {
    const viaHttp = await generateStoryboard({ objective: "遠隔から絵コンテ", endpoint: base, duration: 9 });
    assert.equal(viaHttp.source, `${base}/api/storyboard`);
    assert.equal(viaHttp.storyboard.title, "遠隔から絵コンテ", "the brief must reach the endpoint");
    assert.equal(viaHttp.storyboard.cuts.length, 3);
    // A path on the endpoint is replaced by /api/storyboard, not appended to.
    const viaPath = await generateStoryboard({ objective: "x", endpoint: `${base}/some/page`, duration: 9 });
    assert.equal(viaPath.source, `${base}/api/storyboard`);
  } finally {
    await new Promise((ok) => stub.close(ok));
  }
}

// A server that is down must surface as a clear tool error, not a raw fetch throw.
await assert.rejects(
  () => generateStoryboard({ objective: "x", endpoint: "http://127.0.0.1:1", duration: 9, timeoutMs: 2000 }),
  (e) => e instanceof ToolError && /could not reach/.test(e.message),
  "an unreachable endpoint is a tool error",
);

// --- build_short_video driven by a storyboard -------------------------------

const boardBuilt = buildShortVideo({
  project: folded.project,
  assets: frames.slice(0, 3).map((path) => ({ path })),
  storyboard: handWritten,
  duration: 9,
});
const boardClips = boardBuilt.project.timeline.tracks[0].clips;
assert.equal(boardBuilt.summary.storyboardDriven, true);
assert.equal(boardBuilt.summary.hold, null, "a per-cut storyboard has no single hold");
// The director's pacing must survive rather than being flattened to one length.
assert.ok(new Set(boardClips.map((c) => c.duration)).size > 1, "storyboard pacing must not be flattened");
assert.equal(boardClips[0].duration, boardOnly.storyboard.cuts[0].duration);
assert.deepEqual(boardClips.map((c) => c.purpose), ["hook", "demonstrate", "cta"]);
assert.equal(boardClips[0].motion[0].id, "frame-echo", "storyboard motion is carried onto the clip");
assert.equal(boardClips[0].transitionOut.technique, "glitch");
assert.equal(boardClips.at(-1).transitionOut, null);
assert.equal(boardClips[0].recipe.preset, "NEON");
assert.equal(boardBuilt.summary.totalDuration, 9);
assert.deepEqual(validateProject(boardBuilt.project), { valid: true, errors: [] });

throws(
  () => buildShortVideo({
    project: folded.project,
    assets: frames.map((path) => ({ path })),
    storyboard: handWritten,
  }),
  /storyboard has 3 cuts but 4 assets/,
  "a storyboard must match the asset count",
);

// --- review_hook_and_pacing -------------------------------------------------

const review = reviewHookAndPacing({ project: built.project });
assert.ok(review.score >= 0 && review.score <= 100);
assert.equal(review.cutCount, 4);
const codes = review.findings.map((f) => f.code);
assert.ok(codes.includes("no-captions"), "a project with no captions should be flagged");
assert.ok(review.findings.every((f) => ["error", "warn", "info"].includes(f.severity)));
assert.ok(review.findings.every((f) => f.message && f.suggestion), "every finding needs an actionable suggestion");

// A deliberately bad project: a 10s hook on a 60s-max platform.
const bad = structuredClone(built.project);
bad.timeline.tracks[0].clips[0].duration = 10;
bad.timeline.tracks[0].clips[0].purpose = "explain";
const badReview = reviewHookAndPacing({ project: bad });
const badCodes = badReview.findings.map((f) => f.code);
assert.ok(badCodes.includes("hook-too-long"), "long hook must be flagged");
assert.ok(badCodes.includes("hook-purpose"), "non-hook opener must be flagged");
assert.ok(badCodes.includes("slow-cut"), "a 10s cut must be flagged");
assert.ok(badReview.score < review.score, "a worse project must score lower");

const empty = reviewHookAndPacing({ project: styled.project });
assert.equal(empty.score, 0);
assert.equal(empty.findings[0].code, "no-cuts");

// --- render_project guards --------------------------------------------------
// The happy path needs Chrome and ffmpeg, so only the input guards run here.

await assert.rejects(
  () => renderProject({ project: built.project, output: "out.webm" }),
  /must end in \.mp4/,
  "output extension is checked",
);
await assert.rejects(
  () => renderProject({ project: styled.project, output: "out.mp4" }),
  /at least 2 cuts/,
  "a single cut cannot become a transition video",
);
const embedded = structuredClone(built.project);
embedded.assets[0].source = { kind: "embedded", data: "AA==" };
await assert.rejects(
  () => renderProject({ project: embedded, output: "out.mp4" }),
  /source\.kind "local"/,
  "embedded assets cannot reach the CLI yet",
);
const missing = structuredClone(built.project);
missing.assets[0].source.ref = join(ROOT, "does-not-exist.png");
await assert.rejects(
  () => renderProject({ project: missing, output: "out.mp4" }),
  /asset file not found/,
  "missing files are caught before launching Chrome",
);

// The CLI concatenates pairwise clips, so a clip runs 2*hold + transition and
// every interior cut is drawn twice. renderProject must solve for the hold that
// lands on the timeline duration rather than passing the per-cut duration
// through, which would render roughly twice as long as intended.
{
  const clipsToRender = built.project.timeline.tracks[0].clips;
  const timeline = clipsToRender.reduce((sum, c) => sum + c.duration, 0);
  const pairs = clipsToRender.length - 1;
  const td = clipsToRender[0].transitionOut.duration;
  const hold = Math.min(3, Math.max(0.3, Number(((timeline / pairs - td) / 2).toFixed(3))));
  const predicted = Number((pairs * (2 * hold + td)).toFixed(3));
  assert.ok(
    Math.abs(predicted - timeline) < 0.05,
    `an achievable timeline must render at its own length: ${predicted} vs ${timeline}`,
  );
  assert.ok(hold < timeline / clipsToRender.length, "hold must be shorter than the per-cut duration");
}

// --- JSON-RPC over stdio ----------------------------------------------------

class Client {
  constructor() {
    this.child = spawn(process.execPath, [SERVER], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    this.child.stderr.on("data", (d) => { this.stderr += d; });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let nl;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        const entry = this.pending.get(msg.id);
        if (entry) { this.pending.delete(msg.id); entry(msg); }
      }
    });
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((ok, failReq) => {
      const timer = setTimeout(() => failReq(new Error(`timed out: ${method}`)), 15_000);
      this.pending.set(id, (msg) => { clearTimeout(timer); ok(msg); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  close() {
    return new Promise((ok) => { this.child.once("exit", ok); this.child.stdin.end(); });
  }
}

const client = new Client();
const work = await mkdtemp(join(tmpdir(), "noizlab-mcp-test-"));
try {
  const init = await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "noiz-lab");
  assert.ok(init.result.capabilities.tools, "the server must declare the tools capability");
  assert.ok(init.result.instructions, "instructions help the client drive the tool order");

  // An unknown protocol version gets ours back, not an error.
  const older = await client.request("initialize", { protocolVersion: "1999-01-01", capabilities: {} });
  assert.equal(older.result.protocolVersion, "2025-06-18");

  // Notifications must not produce a reply; if one leaked it would desync the
  // id-keyed pending map and the next request would hang.
  client.notify("notifications/initialized");

  const listed = await client.request("tools/list");
  const names = listed.result.tools.map((t) => t.name);
  for (const expected of [
    "create_project_from_brief", "apply_style_bible", "build_short_video",
    "review_hook_and_pacing", "validate_project", "render_project",
    "read_project", "write_project",
  ]) {
    assert.ok(names.includes(expected), `tools/list must expose ${expected}`);
  }
  for (const tool of listed.result.tools) {
    assert.equal(tool.inputSchema.type, "object", `${tool.name} needs an object inputSchema`);
    assert.ok(tool.description, `${tool.name} needs a description`);
  }

  const called = await client.request("tools/call", {
    name: "create_project_from_brief",
    arguments: { objective: "夏祭りの思い出をVHS風に", platform: "tiktok", duration: 10 },
  });
  assert.equal(called.result.isError, false);
  assert.equal(called.result.content[0].type, "text");
  assert.equal(called.result.structuredContent.plan.preset, "VHS");
  // The text block must carry the same payload for clients that ignore
  // structuredContent.
  assert.deepEqual(JSON.parse(called.result.content[0].text), called.result.structuredContent);
  const rpcProject = called.result.structuredContent.project;

  // Round-trip through disk, which is how a client hands a project to the web UI.
  const path = join(work, "project.json");
  const written = await client.request("tools/call", { name: "write_project", arguments: { project: rpcProject, path } });
  assert.equal(written.result.isError, false);
  const read = await client.request("tools/call", { name: "read_project", arguments: { path } });
  assert.equal(read.result.isError, false);
  assert.equal(read.result.structuredContent.project.id, rpcProject.id);

  // Bad input is a tool execution error (isError) so the model can retry, not a
  // JSON-RPC error that aborts the call.
  const badArgs = await client.request("tools/call", {
    name: "create_project_from_brief",
    arguments: { platform: "tiktok" },
  });
  assert.equal(badArgs.result.isError, true);
  assert.match(badArgs.result.content[0].text, /objective/);
  assert.equal(badArgs.error, undefined, "input validation must not surface as a protocol error");

  const readMissing = await client.request("tools/call", {
    name: "read_project",
    arguments: { path: join(work, "nope.json") },
  });
  assert.equal(readMissing.result.isError, true);

  const writeInvalid = await client.request("tools/call", {
    name: "write_project",
    arguments: { project: { format: "wrong" }, path: join(work, "bad.json") },
  });
  assert.equal(writeInvalid.result.isError, true);
  assert.match(writeInvalid.result.content[0].text, /refusing to write/);

  // Unknown tools and methods are protocol errors.
  const unknownTool = await client.request("tools/call", { name: "no_such_tool", arguments: {} });
  assert.equal(unknownTool.error.code, -32602);
  const unknownMethod = await client.request("resources/list");
  assert.equal(unknownMethod.error.code, -32601);

  const pong = await client.request("ping");
  assert.deepEqual(pong.result, {});

  assert.equal(client.stderr.trim(), "", `server wrote to stderr: ${client.stderr}`);
} finally {
  await client.close();
  await rm(work, { recursive: true, force: true });
}

console.log("NOIZ LAB MCP server tests passed");
