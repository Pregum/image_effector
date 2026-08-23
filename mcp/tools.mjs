// NOIZ LAB MCP tools. Pure functions over the shared Project JSON format so the
// same logic can back a stdio server, a CLI, or a future Worker endpoint.

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createAssetId, createClipId, createProject, validateProject,
} from "../public/project-format.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VARIETY_CLI = join(ROOT, "scripts/noizlab-variety-video.mjs");

const PRESETS = ["RESET", "Y2K", "VHS", "DREAM", "PRINT", "PIXEL", "SORTED", "CINEMA", "FILM", "NEON"];
const TRANSITIONS = ["fade", "wipe", "dissolve", "glitch", "punch", "flash", "push", "film-burn"];
const PLATFORMS = ["generic", "tiktok", "instagram-reels", "youtube-shorts", "presentation"];
const PURPOSES = ["hook", "explain", "demonstrate", "reveal", "emotion", "cta", "unspecified"];

// Vertical platforms crop to 9:16; a deck stays 16:9. Keeps render/canvas honest
// so review_hook_and_pacing can flag a mismatch instead of silently letting a
// 16:9 cut get centre-cropped on TikTok.
const PLATFORM_SHAPE = {
  generic: { ratio: "16:9", width: 1280, height: 720, maxDuration: 0 },
  tiktok: { ratio: "9:16", width: 720, height: 1280, maxDuration: 180 },
  "instagram-reels": { ratio: "9:16", width: 720, height: 1280, maxDuration: 90 },
  "youtube-shorts": { ratio: "9:16", width: 720, height: 1280, maxDuration: 60 },
  presentation: { ratio: "16:9", width: 1280, height: 720, maxDuration: 0 },
};

// Mood keyword -> preset. The keys are matched as substrings against the mood
// list and the objective, in both languages, so a brief written in prose still
// lands on a preset instead of falling through to the default.
const MOOD_PRESETS = [
  [["y2k", "サイバー", "デジタル", "ネット"], "Y2K"],
  [["vhs", "レトロ", "90", "テープ", "nostalg", "ノスタル"], "VHS"],
  [["dream", "夢", "ドリーム", "ふわ", "やわらか", "soft", "ethereal"], "DREAM"],
  [["print", "印刷", "紙", "ざら", "zine", "コラージュ"], "PRINT"],
  [["pixel", "ドット", "ピクセル", "8bit", "ゲーム"], "PIXEL"],
  [["sort", "ソート", "崩", "破壊", "abstract"], "SORTED"],
  [["neon", "ネオン", "夜", "night", "都市", "街", "光"], "NEON"],
  [["film", "フィルム", "粒子", "grain", "アナログ", "記憶"], "FILM"],
  [["cinema", "シネマ", "映画", "エモ", "emotional", "壮大"], "CINEMA"],
];

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round = (n, digits = 3) => Number(n.toFixed(digits));
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

export class ToolError extends Error {}

function fail(message) { throw new ToolError(message); }

function requireString(value, field, { max = 1000, allowEmpty = false } = {}) {
  if (typeof value !== "string") fail(`${field} must be a string`);
  const text = value.trim();
  if (!allowEmpty && !text) fail(`${field} must not be empty`);
  if (text.length > max) fail(`${field} must be ${max} characters or fewer`);
  return text;
}

function requireEnum(value, field, allowed, fallback) {
  if (value == null) return fallback;
  if (!allowed.includes(value)) fail(`${field} must be one of: ${allowed.join(", ")}`);
  return value;
}

function requireNumber(value, field, { min, max, fallback } = {}) {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) fail(`${field} must be a number`);
  if (min != null && n < min) fail(`${field} must be >= ${min}`);
  if (max != null && n > max) fail(`${field} must be <= ${max}`);
  return n;
}

function requireStringArray(value, field, { maxItems = 16, maxLength = 80 } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(`${field} must be an array of strings`);
  if (value.length > maxItems) fail(`${field} must have ${maxItems} items or fewer`);
  return value.map((item, i) => requireString(item, `${field}[${i}]`, { max: maxLength }));
}

// Callers hand a whole project back on every edit tool. Validate before touching
// it so a malformed project fails with the format's own error list rather than a
// TypeError from deep inside a helper.
function requireProject(value, field = "project") {
  if (!isObj(value)) fail(`${field} must be an object`);
  const { valid, errors } = validateProject(value);
  if (!valid) fail(`${field} is not a valid NOIZ LAB project: ${errors.slice(0, 4).join(" / ")}`);
  return structuredClone(value);
}

function visualTrack(project) {
  const track = project.timeline.tracks.find((t) => t.type === "visual");
  if (!track) fail("project has no visual track");
  return track;
}

function touch(project) {
  project.updatedAt = new Date().toISOString();
  return project;
}

function presetForMood(moods, objective) {
  const haystack = [...moods, objective].join(" ").toLowerCase();
  for (const [keywords, preset] of MOOD_PRESETS) {
    if (keywords.some((word) => haystack.includes(word))) return preset;
  }
  return "CINEMA";
}

// A cut plan, not a render: how many cuts fit the duration and what each one is
// for. Short-form pacing wants a fast hook and a longer landing, so the hook is
// squeezed and the final cut gets the remainder.
function planCuts(duration, platform) {
  const target = duration > 0 ? duration : 15;
  const beat = target <= 10 ? 1.6 : target <= 30 ? 2.2 : 3;
  const count = clamp(Math.round(target / beat), 2, 8);
  const purposes = ["hook", "explain", "demonstrate", "reveal", "emotion", "cta"];
  const plan = [];
  for (let i = 0; i < count; i++) {
    const purpose = i === 0 ? "hook"
      : i === count - 1 ? (platform === "presentation" ? "reveal" : "cta")
      : purposes[Math.min(i, purposes.length - 2)];
    plan.push({ purpose, duration: round(target / count) });
  }
  // The hook is 30% shorter than average. Rounding each cut independently would
  // let the total drift off the requested duration, so the last cut absorbs both
  // the hook's surplus and the accumulated rounding error.
  plan[0].duration = round(plan[0].duration * 0.7);
  const allocated = plan.slice(0, -1).reduce((sum, cut) => sum + cut.duration, 0);
  plan[plan.length - 1].duration = round(target - allocated);
  return plan;
}

/** create_project_from_brief */
export function createProjectFromBrief(args = {}) {
  const objective = requireString(args.objective, "objective", { max: 1000 });
  const audience = requireString(args.audience ?? "", "audience", { max: 500, allowEmpty: true });
  const platform = requireEnum(args.platform, "platform", PLATFORMS, "generic");
  const duration = requireNumber(args.duration, "duration", { min: 0, max: 3600, fallback: 15 });
  const mood = requireStringArray(args.mood, "mood");
  const language = requireString(args.language ?? "ja", "language", { max: 16 });
  const title = requireString(args.title ?? objective.slice(0, 80), "title", { max: 160 });

  const shape = PLATFORM_SHAPE[platform];
  if (shape.maxDuration && duration > shape.maxDuration) {
    fail(`${platform} accepts at most ${shape.maxDuration}s; requested ${duration}s`);
  }
  const preset = presetForMood(mood, objective);
  const plan = planCuts(duration, platform);

  const project = createProject({
    title,
    brief: { objective, audience, platform, duration, mood, language },
    styleBible: { negativePrompt: "text artifacts, watermark, distorted hands", seed: 1 },
    canvas: { width: shape.width, height: shape.height, ratio: shape.ratio, fps: 30 },
    render: { width: shape.width, height: shape.height, fps: 30, codec: "h264", container: "mp4" },
  });

  // No assets yet: the plan is returned alongside the project so the caller
  // knows exactly how many cuts to supply before build_short_video will work.
  return {
    project,
    plan: {
      preset,
      ratio: shape.ratio,
      cutCount: plan.length,
      totalDuration: round(plan.reduce((sum, cut) => sum + cut.duration, 0)),
      cuts: plan,
    },
    missingAssets: plan.length,
    nextStep: `Add ${plan.length} assets, then call build_short_video with preset ${preset}.`,
  };
}

// Builds the one style string appended to every prompt, so separately generated
// cuts still look like they belong to the same piece. This is the whole point of
// the style bible: consistency across generations, not per-cut prettiness.
function styleSuffix(bible) {
  return [
    Array.isArray(bible?.texture) ? bible.texture.join(", ") : "",
    bible?.lighting || "",
    bible?.camera || "",
    Array.isArray(bible?.palette) && bible.palette.length
      ? `color palette ${bible.palette.join(" ")}`
      : "",
  ].filter(Boolean).join(", ").slice(0, 300);
}

/**
 * generate_missing_assets
 *
 * Generates the cuts a storyboard calls for but has no file for, via a NOIZ LAB
 * deployment's /api/assets (Workers AI). Images are written to outDir and added
 * to the project as local assets, ready for build_short_video.
 */
export async function generateMissingAssets(args = {}) {
  const project = args.project == null ? null : requireProject(args.project);
  const endpoint = requireString(args.endpoint, "endpoint", { max: 2048 });
  let url;
  try { url = new URL(endpoint); }
  catch { fail(`endpoint is not a valid URL: ${endpoint}`); }
  if (!["http:", "https:"].includes(url.protocol)) fail("endpoint must be http or https");
  const target = new URL("/api/assets", url).href;

  const outDir = resolve(requireString(args.outDir, "outDir", { max: 2048 }));

  // Prompts come either straight from the caller or from a storyboard's cuts.
  let prompts;
  let storyboard = null;
  if (Array.isArray(args.prompts) && args.prompts.length) {
    prompts = requireStringArray(args.prompts, "prompts", { maxItems: 8, maxLength: 500 });
  } else if (args.storyboard != null) {
    storyboard = normalizeStoryboard(args.storyboard, {
      duration: project?.brief.duration ?? 0,
      language: project?.brief.language ?? "ja",
    });
    prompts = storyboard.cuts.map((cut) => cut.imagePrompt || cut.shot).map((p) => p.trim());
    if (prompts.some((p) => !p)) {
      fail("every storyboard cut needs an imagePrompt (or a shot) to generate from");
    }
  } else {
    fail("pass prompts, or a storyboard whose cuts carry imagePrompt");
  }
  if (!prompts.length) fail("nothing to generate");
  if (prompts.length > 8) fail(`at most 8 assets per call; got ${prompts.length}`);

  const bible = args.styleBible ?? project?.styleBible;
  const style = requireString(args.style ?? styleSuffix(bible), "style", { max: 300, allowEmpty: true });
  const negativePrompt = requireString(
    args.negativePrompt ?? bible?.negativePrompt ?? "", "negativePrompt", { max: 300, allowEmpty: true },
  );
  const steps = requireNumber(args.steps, "steps", { min: 4, max: 8, fallback: 6 });

  let res;
  try {
    res = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompts, style, negativePrompt, steps }),
      // Image generation is slow: eight cuts can take a couple of minutes.
      signal: AbortSignal.timeout(requireNumber(args.timeoutMs, "timeoutMs", { min: 5000, max: 600_000, fallback: 300_000 })),
    });
  } catch (error) {
    fail(`could not reach ${target}: ${error.message}`);
  }
  const text = await res.text();
  if (!res.ok) fail(`${target} returned ${res.status}: ${text.slice(0, 200)}`);
  let body;
  try { body = JSON.parse(text); }
  catch { fail(`${target} did not return JSON`); }
  const generated = Array.isArray(body?.assets) ? body.assets : [];
  if (!generated.length) fail(`${target} returned no assets`);

  await mkdir(outDir, { recursive: true });
  const written = [];
  for (const asset of generated) {
    const i = Number.isInteger(asset?.index) ? asset.index : written.length;
    if (typeof asset?.data !== "string" || !asset.data) fail(`asset ${i} has no image data`);
    const bytes = Buffer.from(asset.data, "base64");
    if (!bytes.length) fail(`asset ${i} decoded to an empty file`);
    // Trust the bytes over the label: providers do not always report the type
    // they actually produced, and a .jpg holding PNG data breaks the renderer.
    const png = bytes.length > 8 && bytes.subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const mime = png ? "image/png" : "image/jpeg";
    const path = join(outDir, `cut-${String(i + 1).padStart(2, "0")}.${png ? "png" : "jpg"}`);
    await writeFile(path, bytes);
    written.push({ index: i, path, prompt: asset.prompt ?? prompts[i], contentType: mime });
  }
  // Keep cuts in storyboard order regardless of what order the server replied in.
  written.sort((a, b) => a.index - b.index);

  // The server returns partial results rather than failing the batch, so the
  // caller can retry just the cuts that did not come back.
  const failures = (Array.isArray(body?.errors) ? body.errors : []).map((e) => ({
    index: e?.index,
    error: String(e?.error ?? "unknown"),
    prompt: prompts[e?.index],
  }));

  if (!project) return { assets: written, failures, requested: prompts.length };

  for (const asset of written) {
    project.assets.push({
      id: createAssetId(),
      type: "generated-image",
      name: asset.path.split("/").pop(),
      mime: asset.contentType,
      source: { kind: "local", ref: asset.path },
      metadata: {},
      generation: {
        prompt: asset.prompt,
        style,
        negativePrompt,
        steps,
        // Same seed as the style bible: re-running should stay in the same look.
        seed: project.styleBible.seed,
        provider: target,
      },
    });
  }

  return {
    project: touch(project),
    assets: written,
    failures,
    requested: prompts.length,
    nextStep: failures.length
      ? `${failures.length}カット分が生成できませんでした。再実行するか、その分の素材を用意してください。`
      : `build_short_video に${storyboard ? " storyboard と" : ""}このプロジェクトを渡してタイムラインを作ってください。`,
  };
}

/** apply_style_bible */
export function applyStyleBible(args = {}) {
  const project = requireProject(args.project);
  const bible = isObj(args.styleBible) ? args.styleBible : fail("styleBible must be an object");

  const palette = requireStringArray(bible.palette, "styleBible.palette", { maxItems: 12, maxLength: 7 });
  for (const [i, color] of palette.entries()) {
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) fail(`styleBible.palette[${i}] must be a #rrggbb color`);
  }
  const next = {
    ...project.styleBible,
    palette,
    subjects: Array.isArray(bible.subjects) ? bible.subjects : project.styleBible.subjects,
    lighting: bible.lighting == null ? project.styleBible.lighting : requireString(bible.lighting, "styleBible.lighting", { max: 300, allowEmpty: true }),
    camera: bible.camera == null ? project.styleBible.camera : requireString(bible.camera, "styleBible.camera", { max: 300, allowEmpty: true }),
    texture: bible.texture == null ? project.styleBible.texture : requireStringArray(bible.texture, "styleBible.texture"),
    typography: isObj(bible.typography) ? bible.typography : project.styleBible.typography,
    references: bible.references == null ? project.styleBible.references : requireStringArray(bible.references, "styleBible.references", { maxItems: 16, maxLength: 128 }),
    negativePrompt: bible.negativePrompt == null ? project.styleBible.negativePrompt : requireString(bible.negativePrompt, "styleBible.negativePrompt", { max: 1000, allowEmpty: true }),
    seed: requireNumber(bible.seed, "styleBible.seed", { fallback: project.styleBible.seed }),
  };
  project.styleBible = next;

  // The point of a style bible is that every cut shares it. Stamp the preset
  // onto each clip recipe unless the caller asked to keep per-cut overrides.
  const preset = bible.preset == null ? null : requireEnum(bible.preset, "styleBible.preset", PRESETS);
  const overwrite = args.overwriteCutRecipes !== false;
  let updated = 0;
  if (preset) {
    for (const clip of visualTrack(project).clips) {
      if (!overwrite && isObj(clip.recipe) && clip.recipe.preset) continue;
      clip.recipe = { ...(isObj(clip.recipe) ? clip.recipe : {}), preset, palette, seed: next.seed };
      updated++;
    }
    project.editor.recipe = { ...(isObj(project.editor.recipe) ? project.editor.recipe : {}), preset };
  }
  return { project: touch(project), appliedPreset: preset, updatedCuts: updated };
}

/** build_short_video */
export function buildShortVideo(args = {}) {
  const project = requireProject(args.project);
  const assets = Array.isArray(args.assets) ? args.assets : [];
  if (!assets.length && !project.assets.length) fail("assets must contain at least one item");

  // Assets may arrive with the call or already live on the project. Appending
  // rather than replacing lets a caller build a timeline incrementally.
  for (const [i, asset] of assets.entries()) {
    const path = requireString(asset?.path, `assets[${i}].path`, { max: 2048 });
    const type = requireEnum(asset?.type, `assets[${i}].type`, ["image", "video", "audio", "generated-image", "generated-scene"], "image");
    const ext = extname(path).toLowerCase();
    const mime = asset?.mime ?? (
      { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
        ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm", ".m4a": "audio/mp4",
        ".mp3": "audio/mpeg", ".wav": "audio/wav" }[ext] || "application/octet-stream"
    );
    project.assets.push({
      id: createAssetId(),
      type,
      name: asset?.name ? requireString(asset.name, `assets[${i}].name`, { max: 300 }) : path.split("/").pop(),
      mime: requireString(mime, `assets[${i}].mime`, { max: 120 }),
      // "local" keeps the path on disk so render_project can hand it to the CLI.
      source: { kind: "local", ref: resolve(path) },
      metadata: {},
      generation: null,
    });
  }

  const visuals = project.assets.filter((a) => a.type !== "audio");
  if (!visuals.length) fail("project needs at least one non-audio asset to build a timeline");
  if (visuals.length > 8) fail(`the video pipeline supports at most 8 cuts; got ${visuals.length}`);

  const bpm = requireNumber(args.bpm, "bpm", { min: 0, max: 400, fallback: project.timeline.bpm });
  const beatDivision = requireEnum(args.beatDivision, "beatDivision", [1, 2, 4, 8, 16], project.timeline.beatDivision);
  const transitions = requireStringArray(args.transitions, "transitions", { maxItems: 8, maxLength: 20 });
  for (const [i, t] of transitions.entries()) {
    if (!TRANSITIONS.includes(t)) fail(`transitions[${i}] must be one of: ${TRANSITIONS.join(", ")}`);
  }
  const wheel = transitions.length ? transitions : ["fade", "glitch", "dissolve"];
  const transitionDuration = requireNumber(args.transitionDuration, "transitionDuration", { min: 0.2, max: 2, fallback: 0.9 });

  // Snap holds to the beat grid when a BPM is known, so cuts land on the music
  // instead of drifting against it. Without a BPM, split the brief's duration.
  const target = requireNumber(args.duration, "duration", { min: 0, max: 3600, fallback: project.brief.duration || 15 });
  const beatSeconds = bpm > 0 ? (60 / bpm) * beatDivision : 0;
  const rawHold = target > 0 ? target / visuals.length : 1.4;
  const hold = beatSeconds > 0
    ? clamp(round(Math.max(1, Math.round(rawHold / beatSeconds)) * beatSeconds), 0.3, 3)
    : clamp(round(rawHold), 0.3, 3);
  // A still can only hold 0.3-3s in the render pipeline, so a long duration
  // spread over few cuts cannot be honoured. Report it instead of silently
  // producing a shorter video than the caller asked for.
  const holdClamped = target > 0 && Math.abs(hold - round(rawHold)) > 0.001;

  const purposes = requireStringArray(args.purposes, "purposes", { maxItems: 8, maxLength: 20 });
  for (const [i, p] of purposes.entries()) {
    if (!PURPOSES.includes(p)) fail(`purposes[${i}] must be one of: ${PURPOSES.join(", ")}`);
  }

  // A storyboard carries per-cut durations, purposes, motion and transitions.
  // When one is supplied it drives the timeline, so the deliberate pacing the
  // director wrote survives instead of being flattened to a uniform hold.
  const storyboard = args.storyboard == null
    ? null
    : normalizeStoryboard(args.storyboard, { duration: target, language: project.brief.language });
  if (storyboard && storyboard.cuts.length !== visuals.length) {
    fail(`storyboard has ${storyboard.cuts.length} cuts but ${visuals.length} assets were supplied`);
  }

  const track = visualTrack(project);
  track.clips = [];
  let cursor = 0;
  for (const [i, asset] of visuals.entries()) {
    const last = i === visuals.length - 1;
    const board = storyboard?.cuts[i];
    const purpose = purposes[i] || board?.purpose || (i === 0 ? "hook" : last ? "cta" : "explain");
    const cutDuration = board ? board.duration : hold;
    // Motion alternates so consecutive cuts don't read as the same move; the
    // grammar IDs come from docs/motion-grammar.md.
    const motionId = board?.motion ?? (i % 2 === 0 ? "orthographic-pullback" : "constant-linear");
    const motion = [{
      id: motionId,
      role: "primary",
      params: motionId === "orthographic-pullback"
        ? { fromScale: 1.08, toScale: 1, parallax: 0.2 }
        : motionId === "constant-linear"
        ? { velocity: 0.02, axis: i % 4 === 1 ? "x" : "y", loop: false }
        : {},
    }];
    const technique = board ? board.transitionOut : wheel[i % wheel.length];
    const cutRecipe = board?.preset
      ? { ...(isObj(project.editor.recipe) ? project.editor.recipe : {}), preset: board.preset }
      : isObj(project.editor.recipe) ? { ...project.editor.recipe } : null;
    track.clips.push({
      id: createClipId(),
      assetId: asset.id,
      purpose,
      start: round(cursor),
      duration: cutDuration,
      trim: { in: 0, out: cutDuration },
      recipe: cutRecipe,
      motion,
      transitionOut: last || !technique ? null : {
        technique,
        duration: transitionDuration,
        params: {},
      },
    });
    cursor += cutDuration;
  }

  project.timeline.bpm = bpm;
  project.timeline.beatDivision = beatDivision;

  const audio = project.assets.find((a) => a.type === "audio");
  const { valid, errors } = validateProject(project);
  if (!valid) fail(`built an invalid project: ${errors.slice(0, 4).join(" / ")}`);

  return {
    project: touch(project),
    // Total runtime counts the holds; transitions overlap the cuts either side
    // rather than adding time, which is how the CLI concatenates them.
    summary: {
      cuts: track.clips.length,
      hold: storyboard ? null : hold,
      totalDuration: round(cursor),
      transitions: track.clips.slice(0, -1).map((c) => c.transitionOut.technique),
      bpm,
      beatSnapped: beatSeconds > 0,
      hasAudio: Boolean(audio),
      requestedDuration: target,
      // Present only when the clamp changed the outcome, so a caller can add
      // cuts or accept the shorter runtime.
      ...(storyboard ? { storyboardDriven: true } : {}),
      ...(holdClamped && !storyboard ? {
        note: `1カット${round(rawHold)}秒は範囲外のため${hold}秒に丸めました。全体は${round(cursor)}秒です。想定の${target}秒に近づけるにはカット数を増やしてください。`,
      } : {}),
    },
  };
}

const MOTIONS = [
  "orthographic-pullback", "constant-linear", "frame-echo", "stagger",
  "modular-grid", "match-cut", "controlled-chaos", "on-twos", "pose-to-pose",
  "graphic-substitution", "shape-morph", "silhouette-match", "style-transformation",
  "track-matte", "radial-wipe", "cmyk-misregistration", "halftone", "paper-collage",
];

// An LLM writes the storyboard; this normalises it into something the rest of
// the pipeline can rely on. Anything out of range is clamped or dropped rather
// than rejected, so one bad field does not throw away a usable storyboard.
function normalizeStoryboard(raw, { duration, language }) {
  if (!isObj(raw)) fail("storyboard must be an object");
  const cuts = Array.isArray(raw.cuts) ? raw.cuts.slice(0, 8) : [];
  if (!cuts.length) fail("storyboard.cuts must contain at least one cut");

  const normalized = cuts.map((cut, i) => {
    const last = i === cuts.length - 1;
    const purpose = PURPOSES.includes(cut?.purpose) ? cut.purpose
      : i === 0 ? "hook" : last ? "cta" : "explain";
    const preset = PRESETS.includes(String(cut?.preset).toUpperCase())
      ? String(cut.preset).toUpperCase() : null;
    const motion = MOTIONS.includes(cut?.motion) ? cut.motion : "orthographic-pullback";
    // The final cut must not transition into nothing; every other cut must.
    const technique = TRANSITIONS.includes(cut?.transitionOut) ? cut.transitionOut : "fade";
    return {
      purpose,
      duration: clamp(Number(cut?.duration) > 0 ? Number(cut.duration) : 2, 0.5, 6),
      shot: typeof cut?.shot === "string" ? cut.shot.slice(0, 200) : "",
      caption: typeof cut?.caption === "string" ? cut.caption.slice(0, 60) : "",
      imagePrompt: typeof cut?.imagePrompt === "string" ? cut.imagePrompt.slice(0, 400) : "",
      preset,
      motion,
      transitionOut: last ? null : technique,
    };
  });

  // Rescale to the requested duration so the storyboard and the brief agree;
  // the model is asked for this but does not always land it.
  const target = duration > 0 ? duration : 0;
  const total = normalized.reduce((sum, c) => sum + c.duration, 0);
  if (target > 0 && total > 0 && Math.abs(total - target) > target * 0.02) {
    // The hook is the one cut whose length is deliberate: it has to land within
    // roughly two seconds or the viewer leaves. Stretching it to fill a longer
    // target defeats the storyboard, so hold a short hook and rescale the rest.
    const hook = normalized[0].purpose === "hook" && normalized[0].duration <= 2.5 && normalized.length > 1
      ? normalized[0] : null;
    const scalable = hook ? normalized.slice(1) : normalized;
    const scalableTotal = scalable.reduce((sum, c) => sum + c.duration, 0);
    const scale = (target - (hook?.duration ?? 0)) / scalableTotal;
    for (const cut of scalable) cut.duration = clamp(round(cut.duration * scale), 0.5, 6);
    // Scaling runs into the per-cut limits, so the total can still miss. Settle
    // the remainder one cut at a time: give each cut with headroom as much of
    // what is left as it can take. This terminates and lands exactly, where
    // spreading it evenly leaves rounding dust that never converges. A target
    // that cannot be reached at all (outside cuts*0.5 .. cuts*6) stays short or
    // long; the caller sees it in totalDuration and can change the cut count.
    for (let pass = 0; pass < 3; pass++) {
      let remainder = round(target - normalized.reduce((acc, c) => acc + c.duration, 0));
      if (remainder === 0) break;
      // Protecting the hook is preferred, not absolute: if every other cut is at
      // its limit, releasing the hook is better than silently missing the target.
      const others = normalized.filter((c) => c !== hook);
      const stuck = others.every((c) => remainder > 0 ? c.duration >= 6 : c.duration <= 0.5);
      for (const cut of normalized) {
        if (remainder === 0) break;
        if (cut === hook && !stuck) continue;
        const headroom = remainder > 0 ? round(6 - cut.duration) : round(0.5 - cut.duration);
        if (headroom === 0) continue;
        const give = remainder > 0 ? Math.min(remainder, headroom) : Math.max(remainder, headroom);
        cut.duration = round(cut.duration + give);
        remainder = round(remainder - give);
      }
    }
  }

  return {
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.slice(0, 160) : "",
    logline: typeof raw.logline === "string" ? raw.logline.slice(0, 200) : "",
    language,
    cuts: normalized,
    totalDuration: round(normalized.reduce((sum, c) => sum + c.duration, 0)),
  };
}

/**
 * generate_storyboard
 *
 * The caller can supply a storyboard it wrote itself (the MCP client is an LLM,
 * so this works with no backend at all), or point endpoint at a NOIZ LAB
 * deployment and let the Worker's /api/storyboard write one.
 */
export async function generateStoryboard(args = {}) {
  const project = args.project == null ? null : requireProject(args.project);
  // objective only matters when asking a server to write the storyboard; a
  // caller-supplied one already contains everything needed.
  const objective = args.objective == null
    ? (project?.brief.objective ?? "")
    : requireString(args.objective, "objective", { max: 1000 });
  const duration = requireNumber(args.duration, "duration", {
    min: 0, max: 3600, fallback: project?.brief.duration || 15,
  });
  const language = requireString(args.language ?? project?.brief.language ?? "ja", "language", { max: 16 });

  let storyboard;
  let source;
  if (args.storyboard != null) {
    storyboard = normalizeStoryboard(args.storyboard, { duration, language });
    source = "caller";
  } else {
    const endpoint = requireString(args.endpoint ?? "", "endpoint", { max: 2048, allowEmpty: true });
    if (!endpoint) {
      fail("pass storyboard (write it yourself) or endpoint (a NOIZ LAB deployment whose /api/storyboard writes one)");
    }
    if (!objective) fail("objective is required when generating a storyboard from an endpoint");
    let url;
    try { url = new URL(endpoint); }
    catch { fail(`endpoint is not a valid URL: ${endpoint}`); }
    if (!["http:", "https:"].includes(url.protocol)) fail("endpoint must be http or https");
    const target = new URL("/api/storyboard", url).href;

    const payload = {
      objective,
      duration,
      language,
      platform: args.platform ?? project?.brief.platform ?? "generic",
      audience: args.audience ?? project?.brief.audience ?? "",
      mood: Array.isArray(args.mood) ? args.mood : project?.brief.mood ?? [],
    };
    let res;
    try {
      res = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(requireNumber(args.timeoutMs, "timeoutMs", { min: 1000, max: 120_000, fallback: 60_000 })),
      });
    } catch (error) {
      fail(`could not reach ${target}: ${error.message}`);
    }
    const text = await res.text();
    if (!res.ok) fail(`${target} returned ${res.status}: ${text.slice(0, 200)}`);
    let body;
    try { body = JSON.parse(text); }
    catch { fail(`${target} did not return JSON`); }
    storyboard = normalizeStoryboard(body?.storyboard ?? body, { duration, language });
    source = target;
  }

  // Without a project this is just the storyboard; with one, fold it in so the
  // captions, style and timing survive into build_short_video.
  if (!project) return { storyboard, source };

  // create_project_from_brief derives a title from the objective, so a project
  // is rarely literally "Untitled" and there is no way to tell a derived title
  // from one the user chose. Default to the storyboard's more considered title
  // and let the caller opt out.
  if (storyboard.title && args.keepTitle !== true) project.title = storyboard.title;
  project.captions = storyboard.cuts
    .map((cut, i) => ({ cutIndex: i, text: cut.caption, language }))
    .filter((c) => c.text);

  const presets = storyboard.cuts.map((c) => c.preset).filter(Boolean);
  if (presets.length) {
    // One preset for the whole piece unless the storyboard genuinely varies it.
    const dominant = presets.sort(
      (a, b) => presets.filter((p) => p === b).length - presets.filter((p) => p === a).length,
    )[0];
    project.editor.recipe = { ...(isObj(project.editor.recipe) ? project.editor.recipe : {}), preset: dominant };
  }

  return {
    project: touch(project),
    storyboard,
    source,
    nextStep: `Supply ${storyboard.cuts.length} assets and call build_short_video with plan from this storyboard.`,
  };
}

/** review_hook_and_pacing */
export function reviewHookAndPacing(args = {}) {
  const project = requireProject(args.project);
  const clips = visualTrack(project).clips;
  const findings = [];
  const add = (severity, code, message, suggestion) => findings.push({ severity, code, message, suggestion });

  if (!clips.length) {
    add("error", "no-cuts", "タイムラインにカットがありません。", "build_short_videoで素材を配置してください。");
    return { findings, score: 0, totalDuration: 0 };
  }

  const total = round(clips.reduce((sum, c) => sum + c.duration, 0));
  const shape = PLATFORM_SHAPE[project.brief.platform];

  const hook = clips[0];
  if (hook.purpose !== "hook") {
    add("warn", "hook-purpose", `冒頭カットのpurposeが${hook.purpose}です。`, "1カット目はhookにして、何の動画か2秒で伝えてください。");
  }
  if (hook.duration > 2.5) {
    add("warn", "hook-too-long", `冒頭カットが${hook.duration}秒あります。`, "短尺では冒頭を2秒以下にして離脱を防いでください。");
  }

  if (shape.maxDuration && total > shape.maxDuration) {
    add("error", "over-platform-limit", `${total}秒は${project.brief.platform}の上限${shape.maxDuration}秒を超えています。`, "カット数か1カットの尺を減らしてください。");
  }
  if (project.brief.duration > 0 && Math.abs(total - project.brief.duration) > project.brief.duration * 0.2) {
    add("warn", "duration-drift", `想定${project.brief.duration}秒に対し実尺が${total}秒です。`, "build_short_videoにdurationを渡して尺を合わせてください。");
  }

  // Uniform cut lengths read as a slideshow. Flag it only when there are enough
  // cuts for the rhythm to matter.
  const durations = clips.map((c) => c.duration);
  if (clips.length >= 4 && new Set(durations).size === 1) {
    add("info", "uniform-pacing", "全カットが同じ尺で、単調に見えます。", "フックを短く、締めを長くするなど緩急をつけてください。");
  }
  const longest = Math.max(...durations);
  if (longest > 4) {
    add("warn", "slow-cut", `最長カットが${longest}秒あります。`, "短尺では1カット4秒以内を目安にしてください。");
  }

  const techniques = clips.slice(0, -1).map((c) => c.transitionOut?.technique).filter(Boolean);
  for (let i = 1; i < techniques.length; i++) {
    if (techniques[i] === techniques[i - 1] && techniques.length > 2) {
      add("info", "repeated-transition", `トランジション${techniques[i]}が連続しています。`, "transitionsに複数指定して交互に使ってください。");
      break;
    }
  }

  if (!clips.some((c) => c.purpose === "cta") && project.brief.platform !== "presentation") {
    add("info", "no-cta", "締めのCTAカットがありません。", "最後のカットをctaにして次の行動を促してください。");
  }
  if (!project.captions.length) {
    add("warn", "no-captions", "字幕がありません。", "無音再生でも伝わるよう字幕を入れてください。");
  }
  if (project.canvas.ratio !== shape.ratio) {
    add("warn", "ratio-mismatch", `${project.brief.platform}は${shape.ratio}が基本ですが、canvasは${project.canvas.ratio}です。`, `canvas.ratioを${shape.ratio}にしてください。`);
  }
  if (!project.styleBible.palette.length) {
    add("info", "no-palette", "スタイルバイブルに色が設定されていません。", "apply_style_bibleで配色を固定すると統一感が出ます。");
  }

  const penalty = findings.reduce((sum, f) => sum + ({ error: 30, warn: 12, info: 4 })[f.severity], 0);
  return {
    findings,
    score: clamp(100 - penalty, 0, 100),
    totalDuration: total,
    cutCount: clips.length,
  };
}

/** validate_project */
export function validateProjectTool(args = {}) {
  if (!isObj(args.project)) fail("project must be an object");
  const { valid, errors } = validateProject(args.project);
  return { valid, errors };
}

function run(command, cliArgs, { timeout = 600_000 } = {}) {
  return new Promise((ok, failRun) => {
    const child = spawn(command, cliArgs, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); failRun(new ToolError(`${command} timed out`)); }, timeout);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.once("error", (e) => { clearTimeout(timer); failRun(new ToolError(`could not run ${command}: ${e.message}`)); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) ok({ stdout: out, stderr: err });
      else failRun(new ToolError(`${command} exited with ${code}: ${(err || out).trim().slice(-500)}`));
    });
  });
}

/** render_project — drives the existing Chrome-based CLI. */
export async function renderProject(args = {}) {
  const project = requireProject(args.project);
  const output = resolve(requireString(args.output, "output", { max: 2048 }));
  if (extname(output).toLowerCase() !== ".mp4") fail("output must end in .mp4");

  const clips = visualTrack(project).clips;
  if (clips.length < 2) fail("rendering needs at least 2 cuts");
  if (clips.length > 8) fail(`the video pipeline supports at most 8 cuts; got ${clips.length}`);

  const byId = new Map(project.assets.map((a) => [a.id, a]));
  const cuts = clips.map((clip, i) => {
    const asset = byId.get(clip.assetId);
    // Only on-disk assets can reach the CLI; embedded/R2 sources would need a
    // materialisation step that does not exist yet, so say so plainly.
    if (asset.source.kind !== "local" || !asset.source.ref) {
      fail(`assets[${i}] must have source.kind "local" with a file path to render`);
    }
    if (!existsSync(asset.source.ref)) fail(`asset file not found: ${asset.source.ref}`);
    const preset = clip.recipe?.preset || project.editor.recipe?.preset || "CINEMA";
    if (!PRESETS.includes(preset)) fail(`unknown preset on cut ${i + 1}: ${preset}`);
    return `${asset.source.ref}@${preset}`;
  });

  const transitions = clips.slice(0, -1).map((c) => c.transitionOut?.technique).filter((t) => TRANSITIONS.includes(t));
  const transitionDuration = clamp(round(clips[0].transitionOut?.duration ?? 0.9), 0.2, 2);

  // The CLI renders pairwise clips (cut1→cut2, cut2→cut3, ...) and concatenates
  // them, so every interior cut is drawn twice and one clip runs
  // 2*hold + transitionDuration. Solve for the hold that makes the concatenated
  // result match the timeline instead of passing the per-cut duration straight
  // through, which would render roughly twice as long as intended.
  const timelineDuration = clips.reduce((sum, c) => sum + c.duration, 0);
  const pairs = clips.length - 1;
  const idealHold = (timelineDuration / pairs - transitionDuration) / 2;
  const hold = clamp(round(idealHold), 0.3, 3);
  const predictedDuration = round(pairs * (2 * hold + transitionDuration));

  await mkdir(dirname(output), { recursive: true });
  const cliArgs = [
    VARIETY_CLI, output, ...cuts,
    "--ratio", project.canvas.ratio === "original" ? "16:9" : project.canvas.ratio,
    "--hold", String(hold),
    "--duration", String(transitionDuration),
  ];
  if (transitions.length) cliArgs.push("--transitions", [...new Set(transitions)].join(","));

  const { stdout } = await run(process.execPath, cliArgs, { timeout: requireNumber(args.timeoutMs, "timeoutMs", { min: 10_000, max: 1_800_000, fallback: 900_000 }) });
  return {
    output,
    cuts: cuts.length,
    hold,
    transitions,
    timelineDuration: round(timelineDuration),
    // The real file runs a little longer: each concatenated clip carries about
    // 0.3s of encoder overhead, so expect roughly +0.3s per cut boundary.
    predictedDuration,
    ...(Math.abs(predictedDuration - timelineDuration) > 0.5 ? {
      note: `1カットの保持時間が範囲外のため、書き出しは約${predictedDuration}秒になります（タイムラインは${round(timelineDuration)}秒）。`,
    } : {}),
    log: stdout.trim().split("\n").slice(-5).join("\n"),
  };
}

export const CONSTANTS = { PRESETS, TRANSITIONS, PLATFORMS, PURPOSES, MOTIONS, PLATFORM_SHAPE };
