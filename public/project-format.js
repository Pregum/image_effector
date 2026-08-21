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
