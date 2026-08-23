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
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { callTool } from "../mcp/server.mjs";
import {
  CONSTANTS, ToolError, applyStyleBible, buildShortVideo, createProjectFromBrief,
  generateMissingAssets, generateStoryboard, renderProject, reviewHookAndPacing,
} from "../mcp/tools.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "mcp/server.mjs");

const work0 = await mkdtemp(join(tmpdir(), "noizlab-mcp-assets-"));

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

// --- generate_missing_assets ------------------------------------------------

// A 1x1 PNG, so the test writes and reads back real image bytes rather than
// asserting on a placeholder string.
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

{
  const seen = [];
  const stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      if (req.url !== "/api/assets") { res.writeHead(404).end("{}"); return; }
      const sent = JSON.parse(raw);
      seen.push(sent);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        requested: sent.prompts.length,
        // Reply out of order to prove the caller re-sorts by index.
        assets: sent.prompts.map((prompt, i) => ({
          index: sent.prompts.length - 1 - i,
          prompt: sent.prompts[sent.prompts.length - 1 - i],
          contentType: "image/png",
          data: PNG_1PX,
        })),
        errors: [],
      }));
    });
  });
  await new Promise((ok) => stub.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${stub.address().port}`;
  const outDir = join(work0, "assets");
  try {
    const styled2 = applyStyleBible({
      project: createProjectFromBrief({ objective: "夜のメモアプリ", duration: 9 }).project,
      styleBible: { preset: "NEON", palette: ["#ff00aa"], lighting: "neon night", texture: ["film grain"], seed: 7 },
    }).project;

    const made = await generateMissingAssets({
      project: styled2,
      endpoint: base,
      outDir,
      storyboard: handWritten,
    });
    assert.equal(made.assets.length, 3);
    assert.equal(made.requested, 3);
    assert.deepEqual(made.failures, []);
    // Files must actually exist and contain the bytes the server sent.
    for (const asset of made.assets) {
      const bytes = await readFile(asset.path);
      assert.deepEqual(bytes, Buffer.from(PNG_1PX, "base64"), "the image bytes must round-trip to disk");
    }
    assert.deepEqual(made.assets.map((a) => a.index), [0, 1, 2], "assets are re-sorted into cut order");
    // The extension follows the actual bytes, not the server's label: a .jpg
    // holding PNG data would break the renderer downstream.
    assert.match(made.assets[0].path, /cut-01\.png$/);
    assert.equal(made.assets[0].contentType, "image/png");

    // The style bible must reach every prompt: that is what keeps separately
    // generated cuts looking like one piece.
    assert.equal(seen.length, 1);
    assert.equal(seen[0].prompts.length, 3);
    assert.match(seen[0].style, /neon night/);
    assert.match(seen[0].style, /film grain/);
    assert.match(seen[0].style, /#ff00aa/);
    assert.equal(seen[0].negativePrompt, styled2.styleBible.negativePrompt);
    // The prompts come from the storyboard's imagePrompt, not its captions.
    assert.equal(seen[0].prompts[0], handWritten.cuts[0].imagePrompt);

    assert.equal(made.project.assets.length, 3);
    assert.equal(made.project.assets[0].type, "generated-image");
    assert.equal(made.project.assets[0].source.kind, "local");
    assert.equal(made.project.assets[0].generation.seed, 7, "generation records the style bible seed");
    assert.deepEqual(validateProject(made.project), { valid: true, errors: [] });

    // Generated assets must be usable by the rest of the pipeline unchanged.
    const fromGenerated = buildShortVideo({
      project: made.project,
      storyboard: handWritten,
      duration: 9,
    });
    assert.equal(fromGenerated.summary.cuts, 3);
    assert.deepEqual(validateProject(fromGenerated.project), { valid: true, errors: [] });

    // Without a project, only the files come back.
    const bare = await generateMissingAssets({
      endpoint: base, outDir, prompts: ["a neon sign at night"],
    });
    assert.equal(bare.project, undefined);
    assert.equal(bare.assets.length, 1);
  } finally {
    await new Promise((ok) => stub.close(ok));
  }
}

// Partial failures must surface per cut, not fail the whole batch: the caller
// retries only what did not come back.
{
  const partial = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      const sent = JSON.parse(raw);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        requested: sent.prompts.length,
        assets: [{ index: 0, prompt: sent.prompts[0], contentType: "image/png", data: PNG_1PX }],
        errors: [{ index: 1, error: "quota exceeded" }],
      }));
    });
  });
  await new Promise((ok) => partial.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${partial.address().port}`;
  try {
    const r = await generateMissingAssets({
      endpoint: base, outDir: join(work0, "partial"), prompts: ["one", "two"],
    });
    assert.match(r.assets[0].path, /\.png$/, "PNG bytes get a .png name whatever the label says");
    assert.equal(r.assets.length, 1, "the successful cut is kept");
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].index, 1);
    assert.equal(r.failures[0].prompt, "two", "a failure names the prompt to retry");
  } finally {
    await new Promise((ok) => partial.close(ok));
  }
}

// A batch where nothing succeeded is an error, not an empty success.
{
  const broken = createServer((_req, res) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "generation failed", errors: [{ index: 0, error: "generation failed" }] }));
  });
  await new Promise((ok) => broken.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${broken.address().port}`;
  try {
    await assert.rejects(
      () => generateMissingAssets({ endpoint: base, outDir: join(work0, "broken"), prompts: ["x"] }),
      /returned 502/,
      "a failed batch surfaces the server status",
    );
  } finally {
    await new Promise((ok) => broken.close(ok));
  }
}

await assert.rejects(
  () => generateMissingAssets({ endpoint: "http://127.0.0.1:1", outDir: "/tmp/x" }),
  /pass prompts, or a storyboard/,
  "something to generate is required",
);
await assert.rejects(
  () => generateMissingAssets({ endpoint: "ftp://example.com", outDir: "/tmp/x", prompts: ["a"] }),
  /must be http or https/,
  "non-http endpoints are refused",
);
await assert.rejects(
  () => generateMissingAssets({
    endpoint: "http://127.0.0.1:1", outDir: "/tmp/x",
    storyboard: { cuts: [{ purpose: "hook", duration: 2 }] },
  }),
  /needs an imagePrompt/,
  "a storyboard with no image prompts cannot be generated from",
);
await assert.rejects(
  () => generateMissingAssets({ endpoint: "http://127.0.0.1:1", outDir: "/tmp/x", prompts: ["x"], timeoutMs: 5000 }),
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
// The format calls this field "technique" (transitionOut does too). Writing
// anything else means every reader silently ignores the motion.
assert.equal(boardClips[0].motion[0].technique, "frame-echo", "storyboard motion is carried onto the clip");
assert.equal(boardClips[0].motion[0].id, undefined, "the legacy 'id' key must not be emitted");
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
// A project saved by the Web app has its assets inline. Rendering must unpack
// them rather than refusing, so a browser-authored project renders unchanged.
// (Verified end to end further down; here we only check the guard is gone.)
const unrenderable = structuredClone(built.project);
unrenderable.assets[0].source = { kind: "r2", ref: "works/abc" };
await assert.rejects(
  () => renderProject({ project: unrenderable, output: "out.mp4" }),
  /only local files and embedded data/,
  "a source kind with no fetch path is refused",
);
const missing = structuredClone(built.project);
missing.assets[0].source.ref = join(ROOT, "does-not-exist.png");
await assert.rejects(
  () => renderProject({ project: missing, output: "out.mp4" }),
  /asset file not found/,
  "missing files are caught before launching Chrome",
);

// The CLI concatenates pairwise clips, so every interior cut is drawn twice and
// --hold is a per-cut dwell rather than the clip length. renderProject aims each
// pair at its share of the timeline instead of passing the per-cut duration
// straight through, which would render roughly twice as long as intended.
//
// It deliberately does NOT predict the output length: the export is a real-time
// MediaRecorder capture of the browser's playback, so the same inputs measured
// 2.88s / 3.70s / 4.01s on one machine. renderProject probes the finished file
// instead — see actualDuration.
{
  const clipsToRender = built.project.timeline.tracks[0].clips;
  const timeline = clipsToRender.reduce((sum, c) => sum + c.duration, 0);
  const pairs = clipsToRender.length - 1;
  const td = clipsToRender[0].transitionOut.duration;
  const hold = Math.min(3, Math.max(0.3, Number(((timeline / pairs - td) / 2).toFixed(3))));
  assert.ok(hold < timeline / clipsToRender.length, "hold must be shorter than the per-cut duration");
  assert.ok(hold >= 0.3 && hold <= 3, "hold must stay inside the CLI's accepted range");
}

// A duration figure must never be computed from the timeline and presented as
// what the file will be; only a measurement of the real file is honest here.
{
  const toolsSource = await readFile(join(ROOT, "mcp/tools.mjs"), "utf8");
  assert.ok(!/predictedDuration/.test(toolsSource), "renderProject must not report a predicted duration");
  assert.match(toolsSource, /actualDuration/, "renderProject must report the measured duration");
}

// --- Web app round trip -----------------------------------------------------

// The Web app only materialises assets whose source.kind is "embedded"; a local
// path means nothing in a browser, and importing such a project throws
// 素材がありません. Rather than paraphrase that rule here (a copy would drift
// from the app), lift the real asset-resolution prologue out of
// public/app.js's restoreProject and run it. A change to the app's import rules
// then shows up as a failure here.
const restoreSource = (await readFile(join(ROOT, "public/app.js"), "utf8"))
  .match(/async function restoreProject[\s\S]*?\n\}/)?.[0];
assert.ok(restoreSource, "could not find restoreProject in public/app.js");
const restorePrologue = restoreSource.split("clearSequence()")[0];
assert.match(restorePrologue, /素材がありません/, "the extracted prologue must contain the asset check");

const runAppImport = new Function(
  // storedBlobs is a default parameter in the app (blobs already in IndexedDB);
  // an imported file starts with none, so pass an empty set.
  "manifest", "storedBlobs", "validateProject", "base64ToBlob",
  `return (async () => {${restorePrologue.replace(/^async function restoreProject\([^)]*\)\s*\{/, "")}
    return { blobs: Object.keys(blobs).length, clips: visual.clips.length };
  })()`,
);

// Returns what the Web app would do with this file: open it, or throw.
async function webAppWouldOpen(manifest) {
  try {
    const info = await runAppImport(
      manifest,
      {},
      validateProject,
      (data, type) => ({ size: Buffer.from(data, "base64").length, type }),
    );
    return { ok: true, ...info };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

{
  const roundTrip = join(work0, "roundtrip");
  const projectPath = join(roundTrip, "project.noiz.json");
  const built2 = buildShortVideo({
    project: createProjectFromBrief({ objective: "round trip", duration: 6 }).project,
    assets: frames.slice(0, 2).map((path) => ({ path })),
    duration: 6,
  });
  // A project straight from build_short_video references files on disk, which a
  // browser cannot read: this is exactly the break this feature fixes.
  const beforeEmbed = await webAppWouldOpen(built2.project);
  assert.equal(beforeEmbed.ok, false, "local paths must not be openable in the app");
  assert.match(beforeEmbed.reason, /素材がありません/, "and it fails with the app's own message");

  const written = await callTool("write_project", { project: built2.project, path: projectPath });
  assert.equal(written.embeddedAssets, 2, "local assets are embedded on write");
  assert.equal(written.openableInWebApp, true);
  assert.equal(written.note, undefined, "a fully embedded project needs no warning");

  const onDisk = JSON.parse(await readFile(projectPath, "utf8"));
  assert.deepEqual(validateProject(onDisk), { valid: true, errors: [] });
  assert.ok(onDisk.assets.every((a) => a.source.kind === "embedded"));
  const opened = await webAppWouldOpen(onDisk);
  assert.equal(opened.ok, true, `the written file must open in the Web app: ${opened.reason ?? ""}`);
  assert.equal(opened.blobs, 2, "every asset resolves to a blob");
  assert.equal(opened.clips, 2, "every clip finds its asset");
  // The embedded bytes must be the real image, not a truncated placeholder.
  const firstBytes = Buffer.from(onDisk.assets[0].source.data, "base64");
  assert.deepEqual(firstBytes, await readFile(frames[0]), "embedded data must match the source file");

  // Opting out keeps paths and says so, rather than writing a file that fails
  // to open with no explanation.
  const rawPath = join(roundTrip, "raw.json");
  const raw = await callTool("write_project", { project: built2.project, path: rawPath, embedAssets: false });
  assert.equal(raw.embeddedAssets, 0);
  assert.equal(raw.openableInWebApp, false);
  assert.match(raw.note, /embedAssets/);
  // The opt-out really does produce a file the app rejects, so openableInWebApp
  // is reporting the truth rather than a guess.
  const rawOnDisk = JSON.parse(await readFile(rawPath, "utf8"));
  assert.equal((await webAppWouldOpen(rawOnDisk)).ok, false);

  // Reading back an embedded project warns that it needs unpacking to render.
  const readBack = await callTool("read_project", { path: projectPath });
  assert.equal(readBack.project.id, built2.project.id);
  assert.match(readBack.note, /extractAssetsTo/);

  // ...and unpacking restores files the renderer can read.
  const extractDir = join(roundTrip, "extracted");
  const extracted = await callTool("read_project", { path: projectPath, extractAssetsTo: extractDir });
  assert.equal(extracted.materializedAssets, 2);
  assert.ok(extracted.project.assets.every((a) => a.source.kind === "local"));
  for (const asset of extracted.project.assets) {
    assert.ok(existsSync(asset.source.ref), `extracted file must exist: ${asset.source.ref}`);
  }
  assert.deepEqual(await readFile(extracted.project.assets[0].source.ref), await readFile(frames[0]));
  // The unpacked project is renderable again: the full loop closes.
  assert.deepEqual(validateProject(extracted.project), { valid: true, errors: [] });
}

// --- motion grammar ---------------------------------------------------------

// The app reads clip.motion[].technique (transitionOut uses "technique" too).
// Emitting any other key means the app silently ignores the motion and falls
// back to Ken Burns, which is what used to happen with the old "id" key.
{
  const appSource = await readFile(join(ROOT, "public/app.js"), "utf8");

  // The app's own per-clip motion selection, lifted rather than paraphrased.
  const pickLine = appSource.match(/const motion = clip\.motion\?\.find\([^;]+;/)?.[0];
  assert.ok(pickLine, "could not find the motion selection in public/app.js");
  const pickMotion = new Function("clip", `${pickLine} return motion;`);

  const board = {
    cuts: [
      { purpose: "hook", duration: 3, motion: "orthographic-pullback", transitionOut: "fade", imagePrompt: "a" },
      { purpose: "explain", duration: 3, motion: "constant-linear", transitionOut: "dissolve", imagePrompt: "b" },
      { purpose: "demonstrate", duration: 3, motion: "frame-echo", transitionOut: "glitch", imagePrompt: "c" },
      { purpose: "cta", duration: 3, motion: "modular-grid", transitionOut: null, imagePrompt: "d" },
    ],
  };
  const sb = await generateStoryboard({
    project: createProjectFromBrief({ objective: "motion", duration: 12 }).project,
    storyboard: board,
    duration: 12,
  });
  const withMotion = buildShortVideo({
    project: sb.project,
    assets: frames.map((path) => ({ path })),
    storyboard: sb.storyboard,
    duration: 12,
  });
  const motionClips = withMotion.project.timeline.tracks[0].clips;
  assert.deepEqual(
    motionClips.map((c) => c.motion[0].technique),
    ["orthographic-pullback", "constant-linear", "frame-echo", "modular-grid"],
    "each cut keeps the technique the storyboard asked for",
  );
  // ...and the app resolves every one of them, rather than dropping to a default.
  assert.deepEqual(
    motionClips.map((c) => pickMotion(c)?.technique),
    ["orthographic-pullback", "constant-linear", "frame-echo", "modular-grid"],
    "the Web app must resolve each clip's motion",
  );
  assert.deepEqual(validateProject(withMotion.project), { valid: true, errors: [] });

  // A technique the renderer does not implement must still survive in the file,
  // so a future renderer can honour it (the app falls back for drawing only).
  const exotic = structuredClone(withMotion.project);
  exotic.timeline.tracks[0].clips[0].motion = [{ technique: "shape-morph", role: "primary", params: { easing: "ease" } }];
  assert.deepEqual(validateProject(exotic), { valid: true, errors: [] });
  assert.equal(pickMotion(exotic.timeline.tracks[0].clips[0]).technique, "shape-morph");

  // The validator rejects a motion entry with no technique, which is what let
  // the id/technique mismatch go unnoticed before.
  const badMotion = structuredClone(withMotion.project);
  badMotion.timeline.tracks[0].clips[0].motion = [{ id: "frame-echo", role: "primary" }];
  const badResult = validateProject(badMotion);
  assert.equal(badResult.valid, false, "a motion entry without technique must be rejected");
  assert.match(badResult.errors.join("\n"), /motion\[0\]\.technique is required/);

  // The renderer's technique table and the MCP vocabulary must not drift: every
  // implemented technique has to be one the storyboard is allowed to request.
  const codeMap = appSource.match(/const MOTION_TECH_CODE = \{([^}]*)\}/)?.[1];
  assert.ok(codeMap, "could not find MOTION_TECH_CODE in public/app.js");
  const implemented = [...codeMap.matchAll(/"([a-z-]+)":/g)].map((m) => m[1]);
  assert.ok(implemented.length >= 5, `expected the camera techniques, got ${implemented.join(",")}`);
  for (const technique of implemented) {
    if (technique === "ken-burns") continue; // the app's own default, not a grammar id
    assert.ok(
      CONSTANTS.MOTIONS.includes(technique),
      `${technique} is rendered but generate_storyboard cannot request it`,
    );
  }
}

// --- surface techniques (role: texture) -------------------------------------

// 表面表現は primary のカメラの動きへ「重ねる」ものなので、別枠(role:texture)で
// 共存できないといけない。primary を置き換えてしまうと動きが消える。
{
  const appSource2 = await readFile(join(ROOT, "public/app.js"), "utf8");

  const sb = await generateStoryboard({
    project: createProjectFromBrief({ objective: "surface", duration: 8 }).project,
    storyboard: {
      cuts: [
        { purpose: "hook", duration: 4, motion: "frame-echo", surface: "halftone", transitionOut: "fade", imagePrompt: "a" },
        { purpose: "cta", duration: 4, motion: "constant-linear", surface: "cmyk-misregistration", transitionOut: null, imagePrompt: "b" },
      ],
    },
    duration: 8,
  });
  assert.equal(sb.storyboard.cuts[0].surface, "halftone");
  assert.equal(sb.storyboard.cuts[1].surface, "cmyk-misregistration");

  const surfBuilt = buildShortVideo({
    project: sb.project,
    assets: frames.slice(0, 2).map((path) => ({ path })),
    storyboard: sb.storyboard,
    duration: 8,
  });
  const sClips = surfBuilt.project.timeline.tracks[0].clips;
  // primary と texture が両方載っていること。
  assert.deepEqual(sClips[0].motion.map((m) => m.role), ["primary", "texture"]);
  assert.equal(sClips[0].motion[0].technique, "frame-echo", "カメラの動きが残る");
  assert.equal(sClips[0].motion[1].technique, "halftone", "質感が重なる");
  assert.equal(sClips[1].motion[1].technique, "cmyk-misregistration");
  assert.deepEqual(validateProject(surfBuilt.project), { valid: true, errors: [] });

  // 指定が無ければ texture は付かない（毎カットに質感を足すのは意図ではない）
  const plain = buildShortVideo({
    project: sb.project,
    assets: frames.slice(0, 2).map((path) => ({ path })),
    duration: 8,
  });
  assert.deepEqual(
    plain.project.timeline.tracks[0].clips[0].motion.map((m) => m.role),
    ["primary"],
    "surface未指定のカットに質感を足してはいけない",
  );

  // アプリ側の取り出しでも primary と texture が分かれること。
  const pickLine2 = appSource2.match(/const motion = clip\.motion\?\.find\([^;]+;/)[0];
  const pickSurf = appSource2.match(/const surface = \(clip\.motion \|\| \[\]\)[^;]+;/)?.[0];
  assert.ok(pickSurf, "public/app.js に texture の取り出しが見つからない");
  const split = new Function("clip", `${pickLine2} ${pickSurf} return { motion, surface };`);
  const got = split(sClips[0]);
  assert.equal(got.motion.technique, "frame-echo");
  assert.equal(got.surface.length, 1);
  assert.equal(got.surface[0].technique, "halftone");
  // primary が surface 側に混ざらないこと（!== motion の除外が効いているか）
  assert.ok(!got.surface.includes(got.motion), "primaryがtextureへ混入してはいけない");

  // レンダラーの実装表とMCPの語彙がずれないこと。
  const surfMap = appSource2.match(/const SURFACE_KIND = \{([^}]*)\}/)?.[1];
  assert.ok(surfMap, "public/app.js に SURFACE_KIND が見つからない");
  for (const [, technique] of surfMap.matchAll(/"([a-z-]+)":/g)) {
    assert.ok(
      CONSTANTS.SURFACES.includes(technique),
      `${technique} は描画できるのに generate_storyboard から指定できない`,
    );
  }

  // 数値パラメータが NaN になるとuniform経由で画が真っ黒になる。Number(undefined)
  // は NaN で `?? 既定値` では捕まらないため、有限数かどうかで判定していること。
  const numParamSrc = appSource2.match(/function numParam\([\s\S]*?\n\}/)?.[0];
  assert.ok(numParamSrc, "public/app.js に numParam が見つからない");
  const numParam = new Function(`${numParamSrc} return numParam;`)();
  assert.equal(numParam(undefined, 45), 45, "未指定は既定値になる");
  assert.equal(numParam(null, 45), 45);
  assert.equal(numParam("nonsense", 45), 45, "数値にならない値も既定値になる");
  assert.equal(numParam(0, 45), 0, "0は有効な指定であって既定値ではない");
  assert.equal(numParam(15, 45), 15);
  const surfaceAtSrc = appSource2.match(/function surfaceAt\([\s\S]*?\n\}\n/)?.[0];
  assert.ok(surfaceAtSrc, "public/app.js に surfaceAt が見つからない");
  const kindMapSrc = appSource2.match(/const SURFACE_KIND = \{[^}]*\};/)[0];
  const surfaceAt = new Function(`${kindMapSrc} ${numParamSrc} ${surfaceAtSrc} return surfaceAt;`)();
  for (const technique of ["halftone", "cmyk-misregistration"]) {
    // パラメータ未指定（絵コンテが既定に任せた場合）でも NaN を出さないこと。
    const out = surfaceAt({ surface: [{ technique, role: "texture", params: {} }] }, 0.6);
    for (const [key, value] of Object.entries(out)) {
      assert.ok(Number.isFinite(value), `${technique}.${key} が ${value} になっている`);
    }
  }
  // 未実装の技法は無効化されるだけで、描画を壊さない。
  const unknown = surfaceAt({ surface: [{ technique: "paper-collage", role: "texture", params: {} }] }, 0.5);
  assert.equal(unknown.kind, 0, "未実装の質感は描画しない");
}

// --- connection techniques (transitionOut) ----------------------------------

// track-matte / radial-wipe / silhouette-match はカット「間」の技法なので
// motion[] ではなく transitionOut に載る。既存の8種と同じ仕組みで描くが、
// UIのボタンには出さずProject JSON経由でのみ指定する。
{
  const appSource3 = await readFile(join(ROOT, "public/app.js"), "utf8");

  const connectTechniques = ["track-matte", "radial-wipe", "silhouette-match"];
  for (const technique of connectTechniques) {
    assert.ok(CONSTANTS.TRANSITIONS.includes(technique), `${technique} を絵コンテから指定できない`);
  }

  // レンダラーの並び順がそのまま u_mode になるので、MCP側と一致していないと
  // 別の技法が描かれる。順序込みで突き合わせる。
  const listSrc = appSource3.match(/const TRANSITION_TECHNIQUES = \[([\s\S]*?)\];/)?.[1];
  assert.ok(listSrc, "public/app.js に TRANSITION_TECHNIQUES が見つからない");
  const appTechniques = [...listSrc.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    appTechniques, CONSTANTS.TRANSITIONS,
    "レンダラーとMCPのトランジション一覧は順序込みで一致していないといけない（添字がu_mode）",
  );

  // UIに出す数を超えた技法が来ても、一括選択が範囲外を指さないこと。
  const uiCount = Number(appSource3.match(/const UI_TRANSITION_COUNT = (\d+);/)?.[1]);
  assert.ok(Number.isFinite(uiCount) && uiCount > 0, "UI_TRANSITION_COUNT が読めない");
  for (const technique of connectTechniques) {
    assert.ok(
      appTechniques.indexOf(technique) >= uiCount,
      `${technique} はUIボタンの範囲外に置く想定`,
    );
  }

  const sb = await generateStoryboard({
    project: createProjectFromBrief({ objective: "connect", duration: 9 }).project,
    storyboard: {
      cuts: [
        { purpose: "hook", duration: 3, transitionOut: "track-matte", imagePrompt: "a" },
        { purpose: "explain", duration: 3, transitionOut: "silhouette-match", imagePrompt: "b" },
        { purpose: "cta", duration: 3, transitionOut: null, imagePrompt: "c" },
      ],
    },
    duration: 9,
  });
  assert.equal(sb.storyboard.cuts[0].transitionOut, "track-matte");
  assert.equal(sb.storyboard.cuts[1].transitionOut, "silhouette-match");

  const connBuilt = buildShortVideo({
    project: sb.project,
    assets: frames.slice(0, 3).map((path) => ({ path })),
    storyboard: sb.storyboard,
    duration: 9,
  });
  const cClips = connBuilt.project.timeline.tracks[0].clips;
  assert.equal(cClips[0].transitionOut.technique, "track-matte");
  assert.equal(cClips[1].transitionOut.technique, "silhouette-match");
  assert.equal(cClips[2].transitionOut, null);
  assert.deepEqual(validateProject(connBuilt.project), { valid: true, errors: [] });

  // 書き出し経路(既存CLI)は接続技法を知らない。黙って別の絵を出すのではなく、
  // 落としたことを伝える。
  await assert.rejects(
    () => renderProject({ project: connBuilt.project, output: "out.webm" }),
    /must end in \.mp4/,
    "guard still applies",
  );
  const toolsSrc = await readFile(join(ROOT, "mcp/tools.mjs"), "utf8");
  const cliSet = toolsSrc.match(/const CLI_TRANSITIONS = new Set\(\[([^\]]*)\]\)/)?.[1];
  assert.ok(cliSet, "CLI_TRANSITIONS が見つからない");
  const cliList = [...cliSet.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  for (const technique of connectTechniques) {
    assert.ok(!cliList.includes(technique), `${technique} をCLIへ渡してはいけない`);
  }
  // CLIが受け付ける8種はすべて渡せること（絞りすぎていないか）
  for (const technique of CONSTANTS.TRANSITIONS.slice(0, 8)) {
    assert.ok(cliList.includes(technique), `${technique} はCLIへ渡せるはず`);
  }

  // 接続技法のパラメータ詰めがNaNを出さないこと。u_connectへNaNが流れると
  // 画が壊れるのは表面表現のときと同じ。
  const connectSrc = appSource3.match(/function connectParams\([\s\S]*?\n\}/)?.[0];
  assert.ok(connectSrc, "connectParams が見つからない");
  const numParamSrc2 = appSource3.match(/function numParam\([\s\S]*?\n\}/)[0];
  const connectParams = new Function(`${numParamSrc2} ${connectSrc} return connectParams;`)();
  for (const technique of connectTechniques) {
    for (const params of [{}, { feather: null }, { threshold: "x" }, { center: [null, undefined] }, { startAngle: 0 }]) {
      const out = connectParams(technique, params);
      assert.equal(out.length, 4, `${technique} は vec4 を返すこと`);
      for (const [i, v] of out.entries()) {
        assert.ok(Number.isFinite(v), `${technique} params=${JSON.stringify(params)} の [${i}] が ${v}`);
      }
    }
  }
  // 中心座標は0-1へ収める（画面外を指すと何も出ない）
  const wild = connectParams("radial-wipe", { center: [9, -9] });
  assert.ok(wild[2] >= 0 && wild[2] <= 1 && wild[3] >= 0 && wild[3] <= 1, "中心は0-1に収める");
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

await rm(work0, { recursive: true, force: true });

console.log("NOIZ LAB MCP server tests passed");
