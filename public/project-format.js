export const PROJECT_FORMAT = "noizlab-project";
export const PROJECT_VERSION = 1;

const nowIso = () => new Date().toISOString();
const newId = (prefix) => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
const obj = (v) => v && typeof v === "object" && !Array.isArray(v);

export function createProject(overrides = {}) {
  const now = nowIso();
  const base = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    id: newId("project"),
    title: "Untitled NOIZ LAB Project",
    createdAt: now,
    updatedAt: now,
    brief: { objective: "", audience: "", platform: "generic", duration: 0, mood: [], language: "ja" },
    styleBible: {
      subjects: [], palette: [], lighting: "", camera: "", texture: [], typography: {},
      references: [], negativePrompt: "", seed: 1,
    },
    canvas: { width: 1200, height: 800, ratio: "original", fps: 30 },
    editor: { recipe: null, perCutEffects: true },
    assets: [],
    timeline: { bpm: 120, beatDivision: 2, tracks: [{ id: "visual-main", type: "visual", clips: [] }] },
    captions: [],
    render: { width: 1280, height: 720, fps: 30, codec: "h264", container: "mp4" },
  };
  return {
    ...base, ...overrides,
    brief: { ...base.brief, ...(overrides.brief || {}) },
    styleBible: { ...base.styleBible, ...(overrides.styleBible || {}) },
    canvas: { ...base.canvas, ...(overrides.canvas || {}) },
    editor: { ...base.editor, ...(overrides.editor || {}) },
    timeline: { ...base.timeline, ...(overrides.timeline || {}) },
    render: { ...base.render, ...(overrides.render || {}) },
  };
}

export function validateProject(project) {
  const errors = [];
  if (!obj(project)) return { valid: false, errors: ["project must be an object"] };
  if (project.format !== PROJECT_FORMAT) errors.push(`format must be ${PROJECT_FORMAT}`);
  if (project.version !== PROJECT_VERSION) errors.push(`version must be ${PROJECT_VERSION}`);
  for (const key of ["id", "title", "createdAt", "updatedAt"]) {
    if (typeof project[key] !== "string" || !project[key]) errors.push(`${key} must be a non-empty string`);
  }
  for (const key of ["brief", "styleBible", "canvas", "editor", "timeline", "render"]) {
    if (!obj(project[key])) errors.push(`${key} must be an object`);
  }
  if (!Array.isArray(project.assets)) errors.push("assets must be an array");
  if (!Array.isArray(project.captions)) errors.push("captions must be an array");
  const assetIds = new Set();
  for (const [i, asset] of (project.assets || []).entries()) {
    if (!obj(asset) || typeof asset.id !== "string" || !asset.id) errors.push(`assets[${i}].id is required`);
    else if (assetIds.has(asset.id)) errors.push(`duplicate asset id: ${asset.id}`);
    else assetIds.add(asset.id);
    if (!obj(asset?.source) || !["indexeddb", "embedded", "r2", "url", "local"].includes(asset.source.kind)) {
      errors.push(`assets[${i}].source.kind is invalid`);
    }
    if (asset?.source?.kind === "embedded" && typeof asset.source.data !== "string") {
      errors.push(`assets[${i}].source.data is required for embedded assets`);
    } else if (asset?.source?.kind === "embedded" && asset.source.data.length > 280_000_000) {
      errors.push(`assets[${i}].source.data is too large`);
    }
  }
  if (!Array.isArray(project.timeline?.tracks)) errors.push("timeline.tracks must be an array");
  const clipIds = new Set();
  for (const [ti, track] of (project.timeline?.tracks || []).entries()) {
    if (!Array.isArray(track?.clips)) { errors.push(`timeline.tracks[${ti}].clips must be an array`); continue; }
    for (const [ci, clip] of track.clips.entries()) {
      const path = `timeline.tracks[${ti}].clips[${ci}]`;
      if (!clip?.id || clipIds.has(clip.id)) errors.push(`${path}.id is missing or duplicated`);
      else clipIds.add(clip.id);
      if (!assetIds.has(clip?.assetId)) errors.push(`${path}.assetId does not reference an asset`);
      if (!(clip?.start >= 0)) errors.push(`${path}.start must be >= 0`);
      if (!(clip?.duration > 0)) errors.push(`${path}.duration must be > 0`);
      if (!obj(clip?.trim) || !(clip.trim.in >= 0) || !(clip.trim.out >= clip.trim.in)) errors.push(`${path}.trim is invalid`);
      if (!Array.isArray(clip?.motion)) errors.push(`${path}.motion must be an array`);
      else for (const [mi, motion] of clip.motion.entries()) {
        // technique is the field name used throughout the format (transitionOut
        // uses it too). Enforcing it here stops a writer emitting some other key
        // and having its motion silently ignored by every reader.
        if (!obj(motion) || typeof motion.technique !== "string" || !motion.technique) {
          errors.push(`${path}.motion[${mi}].technique is required`);
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function parseProjectJson(text) {
  let project;
  try { project = JSON.parse(text); }
  catch { throw new Error("Project JSONを解析できませんでした。"); }
  const result = validateProject(project);
  if (!result.valid) throw new Error(`Project JSONが不正です: ${result.errors.slice(0, 4).join(" / ")}`);
  return project;
}

export function stringifyProject(project, pretty = true) {
  const result = validateProject(project);
  if (!result.valid) throw new Error(`Invalid NOIZ LAB project: ${result.errors.join(" / ")}`);
  return JSON.stringify(project, null, pretty ? 2 : 0);
}

export function createAssetId() { return newId("asset"); }
export function createClipId() { return newId("clip"); }

// 投稿先ごとの基本形。review が比率や尺の食い違いを指摘するのに使う。
export const PLATFORM_SHAPE = {
  generic: { ratio: "16:9", width: 1280, height: 720, maxDuration: 0 },
  tiktok: { ratio: "9:16", width: 720, height: 1280, maxDuration: 180 },
  "instagram-reels": { ratio: "9:16", width: 720, height: 1280, maxDuration: 90 },
  "youtube-shorts": { ratio: "9:16", width: 720, height: 1280, maxDuration: 60 },
  presentation: { ratio: "16:9", width: 1280, height: 720, maxDuration: 0 },
};

const reviewClamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const reviewRound = (n, digits = 3) => Number(n.toFixed(digits));

// 冒頭の掴み・尺・緩急・字幕・比率を検査して、指摘とスコアを返す。
// MCP と Web版の両方から同じ基準で呼べるよう、ここに置いている。
export function reviewProject(project) {
  const track = project?.timeline?.tracks?.find((t) => t.type === "visual");
  const clips = track?.clips ?? [];
  const findings = [];
  const add = (severity, code, message, suggestion) => findings.push({ severity, code, message, suggestion });

  if (!clips.length) {
    add("error", "no-cuts", "タイムラインにカットがありません。", "build_short_videoで素材を配置してください。");
    return { findings, score: 0, totalDuration: 0 };
  }

  const total = reviewRound(clips.reduce((sum, c) => sum + c.duration, 0));
  const shape = PLATFORM_SHAPE[project.brief?.platform] || PLATFORM_SHAPE.generic;

  const hook = clips[0];
  if (hook.purpose !== "hook") {
    add("warn", "hook-purpose", `冒頭カットのpurposeが${hook.purpose}です。`, "1カット目はhookにして、何の動画か2秒で伝えてください。");
  }
  if (hook.duration > 2.5) {
    add("warn", "hook-too-long", `冒頭カットが${hook.duration}秒あります。`, "短尺では冒頭を2秒以下にして離脱を防いでください。");
  }

  if (shape.maxDuration && total > shape.maxDuration) {
    add("error", "over-platform-limit", `${total}秒は${project.brief?.platform}の上限${shape.maxDuration}秒を超えています。`, "カット数か1カットの尺を減らしてください。");
  }
  if ((project.brief?.duration || 0) > 0 && Math.abs(total - project.brief.duration) > project.brief.duration * 0.2) {
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

  if (!clips.some((c) => c.purpose === "cta") && project.brief?.platform !== "presentation") {
    add("info", "no-cta", "締めのCTAカットがありません。", "最後のカットをctaにして次の行動を促してください。");
  }
  if (!(project.captions || []).length) {
    add("warn", "no-captions", "字幕がありません。", "無音再生でも伝わるよう字幕を入れてください。");
  }
  if (project.canvas?.ratio !== shape.ratio) {
    add("warn", "ratio-mismatch", `${project.brief?.platform}は${shape.ratio}が基本ですが、canvasは${project.canvas?.ratio}です。`, `canvas.ratioを${shape.ratio}にしてください。`);
  }
  if (!(project.styleBible?.palette || []).length) {
    add("info", "no-palette", "スタイルバイブルに色が設定されていません。", "apply_style_bibleで配色を固定すると統一感が出ます。");
  }

  const penalty = findings.reduce((sum, f) => sum + ({ error: 30, warn: 12, info: 4 })[f.severity], 0);
  return {
    findings,
    score: reviewClamp(100 - penalty, 0, 100),
    totalDuration: total,
    cutCount: clips.length,
  };
}
