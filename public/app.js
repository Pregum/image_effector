/* NOIZ LAB — 画像エフェクト実験室
 * すべての画像処理はブラウザ内 WebGL2 + Canvas で完結する。
 */

const MAX_EDGE = 1600; // 処理解像度の上限（長辺）

// ---------------------------------------------------------------- shaders

const VERT = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 verts[3] = vec2[3](vec2(-1.,-1.), vec2(3.,-1.), vec2(-1.,3.));
  vec2 p = verts[gl_VertexID];
  gl_Position = vec4(p, 0., 1.);
  v_uv = p * 0.5 + 0.5;
}`;

const FRAG_BLUR = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_tex;
uniform vec2 u_dir;   // (1,0) or (0,1)
uniform vec2 u_res;
uniform float u_radius;
void main() {
  float sigma = max(u_radius * 0.5, 0.001);
  float total = 0.0;
  vec3 acc = vec3(0.0);
  for (int i = -40; i <= 40; i++) {
    float fi = float(i);
    if (abs(fi) > u_radius) continue;
    float w = exp(-fi * fi / (2.0 * sigma * sigma));
    acc += texture(u_tex, v_uv + u_dir * fi / u_res).rgb * w;
    total += w;
  }
  o = vec4(acc / total, 1.0);
}`;

const FRAG_BRIGHT = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_tex;
uniform float u_thresh;
void main() {
  vec3 c = texture(u_tex, v_uv).rgb;
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  float m = smoothstep(u_thresh, 1.0, lum);
  o = vec4(c * m, 1.0);
}`;

const FRAG_FINAL = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_base;
uniform sampler2D u_glow;
uniform vec2 u_res;
uniform float u_time;
uniform float u_seed;
uniform float u_glitch;
uniform float u_rgb;      // 色収差 px
uniform float u_halation;
uniform float u_pixel;    // モザイクセル px (<=1 で無効)
uniform int   u_dmode;    // 0:none 1:bayer 2:halftone
uniform float u_dscale;
uniform float u_levels;
uniform float u_curve;
uniform float u_scan;
uniform float u_noise;
uniform float u_vig;

float hash(float n) { return fract(sin(n * 127.1 + u_seed * 311.7) * 43758.5453); }
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + u_seed * 17.0) * 43758.5453); }

float bayer(vec2 ip) {
  int x = int(mod(ip.x, 8.0));
  int y = int(mod(ip.y, 8.0));
  int m[64] = int[64](
     0,32, 8,40, 2,34,10,42,  48,16,56,24,50,18,58,26,
    12,44, 4,36,14,46, 6,38,  60,28,52,20,62,30,54,22,
     3,35,11,43, 1,33, 9,41,  51,19,59,27,49,17,57,25,
    15,47, 7,39,13,45, 5,37,  63,31,55,23,61,29,53,21);
  return (float(m[y * 8 + x]) + 0.5) / 64.0;
}

void main() {
  vec2 uv = v_uv;

  // CRT 湾曲
  if (u_curve > 0.0) {
    vec2 c = uv * 2.0 - 1.0;
    c *= 1.0 + u_curve * 0.11 * dot(c, c);
    uv = c * 0.5 + 0.5;
  }
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);

  // モザイク
  vec2 puv = uv;
  if (u_pixel > 1.0) {
    puv = (floor(uv * u_res / u_pixel) + 0.5) * u_pixel / u_res;
  }

  // グリッチ（帯ずれ＋ラインジッタ）
  float extraShift = 0.0;
  if (u_glitch > 0.0) {
    float t8 = floor(u_time * 8.0);
    float bands = 22.0 + floor(u_glitch * 26.0);
    float band = floor(puv.y * bands);
    float r1 = hash(band + t8 * 13.0);
    if (r1 > 1.0 - u_glitch * 0.35) {
      float mag = (hash(band * 7.0 + t8) - 0.5) * 2.0;
      puv.x += mag * u_glitch * 0.12;
      extraShift = u_glitch * 6.0;
    }
    float line = floor(puv.y * u_res.y);
    float t24 = floor(u_time * 24.0);
    puv.x += (hash(line + t24) - 0.5) * u_glitch * u_glitch * 0.025
             * step(0.72, hash(line * 3.1 + t24));
  }

  // 色収差
  float sh = (u_rgb + extraShift) / u_res.x;
  vec3 col;
  col.r = texture(u_base, puv + vec2(sh, 0.0)).r;
  col.g = texture(u_base, puv).g;
  col.b = texture(u_base, puv - vec2(sh, 0.0)).b;

  // ハレーション（暖色寄りのにじみ）
  if (u_halation > 0.0) {
    vec3 glow = texture(u_glow, puv).rgb;
    col += glow * u_halation * vec3(1.15, 0.95, 0.8);
  }

  // ディザ / ハーフトーン
  if (u_dmode == 1) {
    float lv = max(u_levels, 2.0) - 1.0;
    float b = bayer(floor(gl_FragCoord.xy / max(u_dscale, 1.0)));
    col = floor(col * lv + b) / lv;
  } else if (u_dmode == 2) {
    float cell = max(u_dscale, 2.0) * 2.0;
    float a = 0.4;
    mat2 R = mat2(cos(a), -sin(a), sin(a), cos(a));
    vec2 p = R * (puv * u_res);
    vec2 center = (floor(p / cell) + 0.5) * cell;
    vec2 cuv = transpose(R) * center / u_res;
    vec3 sc = texture(u_base, clamp(cuv, 0.0, 1.0)).rgb;
    float lum = dot(sc, vec3(0.299, 0.587, 0.114));
    float rad = sqrt(1.0 - lum) * cell * 0.72;
    float d = length(p - center);
    float m = 1.0 - smoothstep(rad - 0.8, rad + 0.8, d);
    col = mix(vec3(0.955, 0.945, 0.915), sc * 0.82, m);
  }

  // 走査線＋アパーチャグリル
  if (u_scan > 0.0) {
    col *= 1.0 - u_scan * 0.35 * (0.5 + 0.5 * sin(uv.y * u_res.y * 2.094));
    col *= 1.0 - u_scan * 0.12 * (0.5 + 0.5 * sin(uv.x * u_res.x * 2.094));
  }

  // グレイン
  if (u_noise > 0.0) {
    col += (hash2(uv * u_res + fract(u_time) * vec2(7.0, 3.0)) - 0.5) * u_noise * 0.4;
  }

  // ビネット
  vec2 dc = uv - 0.5;
  col *= 1.0 - u_vig * 1.6 * dot(dc, dc);

  o = vec4(col * inside, 1.0);
}`;

// ---------------------------------------------------------------- GL setup

const canvas = document.getElementById("view");
const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true, antialias: false });
if (!gl) {
  document.body.innerHTML = "<p style='padding:40px'>WebGL2 に対応したブラウザでご覧ください。</p>";
  throw new Error("no webgl2");
}
gl.bindVertexArray(gl.createVertexArray());

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(s));
  }
  return s;
}
function program(fragSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(p));
  }
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    uniforms[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { prog: p, u: uniforms };
}

const blurP = program(FRAG_BLUR);
const brightP = program(FRAG_BRIGHT);
const finalP = program(FRAG_FINAL);

function makeTex(w, h) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (w) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  return t;
}
function makeFbo(w, h) {
  const tex = makeTex(w, h);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fbo };
}

const srcTex = makeTex();
const blackTex = makeTex();
gl.bindTexture(gl.TEXTURE_2D, blackTex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));

let fboA = null, fboB = null, fboC = null, fboD = null;
let W = 0, H = 0;

function allocFbos(w, h) {
  for (const f of [fboA, fboB, fboC, fboD]) {
    if (f) { gl.deleteTexture(f.tex); gl.deleteFramebuffer(f.fbo); }
  }
  fboA = makeFbo(w, h); fboB = makeFbo(w, h);
  fboC = makeFbo(w, h); fboD = makeFbo(w, h);
}

// ---------------------------------------------------------------- state / UI

const state = {
  blur: 6,
  sortLow: 0.25, sortHigh: 0.85, sortVert: 0,
  glitch: 0.5,
  rgb: 6,
  halation: 0.8, halThresh: 0.55,
  pixel: 10,
  dmode: 1, dscale: 3, levels: 4,
  curve: 0.4, scan: 0.5,
  noise: 0.3, vig: 0.4,
};
const DEFAULTS = { ...state };
const enabled = {
  blur: false, sort: false, glitch: false, rgb: false, halation: false,
  pixel: false, dither: false, crt: false, grain: false,
};
let seed = 1;
let animate = true;
let frozenTime = 0;
let dirty = true;

const MODULES = [
  { id: "blur", name: "BLUR", jp: "ぼかし",
    params: [{ key: "blur", label: "強さ", min: 0, max: 40, step: 0.5 }] },
  { id: "sort", name: "PIXEL SORT", jp: "ピクセルソート",
    seg: { key: "sortVert", options: ["よこ", "たて"] },
    params: [
      { key: "sortLow", label: "しきい値・下", min: 0, max: 1, step: 0.01 },
      { key: "sortHigh", label: "しきい値・上", min: 0, max: 1, step: 0.01 },
    ] },
  { id: "glitch", name: "GLITCH", jp: "グリッチ", dice: true,
    params: [{ key: "glitch", label: "強さ", min: 0, max: 1, step: 0.01 }] },
  { id: "rgb", name: "RGB SHIFT", jp: "色収差",
    params: [{ key: "rgb", label: "ずれ幅", min: 0, max: 30, step: 0.5 }] },
  { id: "halation", name: "HALATION", jp: "ハレーション",
    params: [
      { key: "halation", label: "強さ", min: 0, max: 1.5, step: 0.01 },
      { key: "halThresh", label: "しきい値", min: 0, max: 1, step: 0.01 },
    ] },
  { id: "pixel", name: "PIXELATE", jp: "モザイク",
    params: [{ key: "pixel", label: "サイズ", min: 2, max: 64, step: 1 }] },
  { id: "dither", name: "DITHER", jp: "ディザ / 網点",
    seg: { key: "dmode", options: ["ベイヤー", "ハーフトーン"], offset: 1 },
    params: [
      { key: "dscale", label: "スケール", min: 1, max: 20, step: 1 },
      { key: "levels", label: "階調", min: 2, max: 8, step: 1 },
    ] },
  { id: "crt", name: "CRT / VHS", jp: "ブラウン管",
    params: [
      { key: "curve", label: "湾曲", min: 0, max: 1, step: 0.01 },
      { key: "scan", label: "走査線", min: 0, max: 1, step: 0.01 },
    ] },
  { id: "grain", name: "GRAIN", jp: "粒子・減光",
    params: [
      { key: "noise", label: "グレイン", min: 0, max: 1, step: 0.01 },
      { key: "vig", label: "ビネット", min: 0, max: 1, step: 0.01 },
    ] },
];

const PRESETS = [
  { name: "RESET", on: {}, set: {} },
  { name: "Y2K", on: { glitch: 1, rgb: 1, crt: 1, grain: 1 },
    set: { glitch: 0.55, rgb: 8, curve: 0, scan: 0.35, noise: 0.15, vig: 0.15 } },
  { name: "VHS", on: { rgb: 1, crt: 1, grain: 1, blur: 1 },
    set: { rgb: 4, curve: 0.5, scan: 0.65, noise: 0.35, vig: 0.5, blur: 1.5 } },
  { name: "DREAM", on: { halation: 1, blur: 1, grain: 1 },
    set: { halation: 1.1, halThresh: 0.5, blur: 3, noise: 0.12, vig: 0.35 } },
  { name: "PRINT", on: { dither: 1, grain: 1 },
    set: { dmode: 2, dscale: 4, noise: 0.06, vig: 0.1 } },
  { name: "PIXEL", on: { pixel: 1, dither: 1 },
    set: { pixel: 8, dmode: 1, dscale: 4, levels: 4 } },
  { name: "SORTED", on: { sort: 1, rgb: 1, grain: 1 },
    set: { sortLow: 0.3, sortHigh: 0.85, rgb: 6, noise: 0.1, vig: 0.2 } },
];

const rack = document.getElementById("rack");
const controls = {}; // key -> {input, valEl}

function fmt(v, step) { return step >= 1 ? String(Math.round(v)) : (+v).toFixed(2); }

for (const mod of MODULES) {
  const el = document.createElement("div");
  el.className = "module";
  el.dataset.id = mod.id;

  const head = document.createElement("div");
  head.className = "module-head";
  head.innerHTML = `<span class="led"></span><span class="module-name">${mod.name}<span class="jp">${mod.jp}</span></span>`;
  head.addEventListener("click", () => {
    enabled[mod.id] = !enabled[mod.id];
    el.classList.toggle("on", enabled[mod.id]);
    if (mod.id === "sort") scheduleSort();
    markDirty();
  });
  el.appendChild(head);

  const body = document.createElement("div");
  body.className = "module-body";

  if (mod.seg) {
    const seg = document.createElement("div");
    seg.className = "seg";
    const offset = mod.seg.offset || 0;
    mod.seg.options.forEach((label, i) => {
      const b = document.createElement("button");
      b.textContent = label;
      const val = i + offset;
      if (state[mod.seg.key] === val || (offset && i === 0)) b.classList.add("sel");
      b.addEventListener("click", () => {
        state[mod.seg.key] = val;
        seg.querySelectorAll("button").forEach((x) => x.classList.remove("sel"));
        b.classList.add("sel");
        if (mod.id === "sort") scheduleSort();
        markDirty();
      });
      seg.appendChild(b);
    });
    controls[mod.seg.key] = { seg, offset };
    body.appendChild(seg);
  }

  for (const p of mod.params) {
    const ctl = document.createElement("div");
    ctl.className = "ctl";
    const label = document.createElement("div");
    label.className = "ctl-label";
    label.innerHTML = `<span>${p.label}</span><span class="val">${fmt(state[p.key], p.step)}</span>`;
    const input = document.createElement("input");
    input.type = "range";
    input.min = p.min; input.max = p.max; input.step = p.step;
    input.value = state[p.key];
    const valEl = label.querySelector(".val");
    input.addEventListener("input", () => {
      state[p.key] = +input.value;
      valEl.textContent = fmt(state[p.key], p.step);
      if (mod.id === "sort") scheduleSort();
      markDirty();
    });
    controls[p.key] = { input, valEl, step: p.step };
    ctl.appendChild(label);
    ctl.appendChild(input);
    body.appendChild(ctl);
  }

  if (mod.dice) {
    const b = document.createElement("button");
    b.className = "dice";
    b.textContent = "◇ パターンを振り直す";
    b.addEventListener("click", () => { seed = Math.random() * 100; markDirty(); });
    body.appendChild(b);
  }

  el.appendChild(body);
  rack.appendChild(el);
}

function syncUI() {
  for (const mod of MODULES) {
    rack.querySelector(`[data-id="${mod.id}"]`).classList.toggle("on", enabled[mod.id]);
  }
  for (const [key, c] of Object.entries(controls)) {
    if (c.input) {
      c.input.value = state[key];
      c.valEl.textContent = fmt(state[key], c.step);
    } else if (c.seg) {
      const idx = Math.max(0, state[key] - c.offset);
      c.seg.querySelectorAll("button").forEach((b, i) => b.classList.toggle("sel", i === idx));
    }
  }
}

const presetRow = document.getElementById("presets");
for (const pr of PRESETS) {
  const b = document.createElement("button");
  b.className = "preset-chip";
  b.textContent = pr.name;
  b.addEventListener("click", () => applyPreset(pr));
  presetRow.appendChild(b);
}

function applyPreset(pr) {
  Object.assign(state, DEFAULTS, pr.set);
  for (const k of Object.keys(enabled)) enabled[k] = !!pr.on[k];
  seed = Math.random() * 100;
  syncUI();
  scheduleSort();
  markDirty();
}

document.getElementById("btn-random").addEventListener("click", () => {
  const pool = ["blur", "glitch", "rgb", "halation", "pixel", "dither", "crt", "grain", "sort"];
  Object.assign(state, DEFAULTS);
  for (const k of Object.keys(enabled)) enabled[k] = false;
  const count = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < count; i++) {
    enabled[pool[Math.floor(Math.random() * pool.length)]] = true;
  }
  state.glitch = 0.2 + Math.random() * 0.6;
  state.rgb = 2 + Math.random() * 12;
  state.blur = 1 + Math.random() * 6;
  state.pixel = 4 + Math.floor(Math.random() * 16);
  state.dmode = Math.random() < 0.5 ? 1 : 2;
  state.dscale = 2 + Math.floor(Math.random() * 5);
  state.noise = Math.random() * 0.5;
  state.scan = Math.random() * 0.7;
  state.curve = Math.random() * 0.5;
  state.vig = Math.random() * 0.5;
  state.halation = 0.4 + Math.random() * 0.8;
  seed = Math.random() * 100;
  syncUI();
  scheduleSort();
  markDirty();
});

// ---------------------------------------------------------------- pixel sort

let originalData = null; // ImageData（処理解像度）

function lumOf(d, i) {
  return d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
}

function pixelSorted(src, low, high, vertical) {
  const { width: w, height: h } = src;
  const out = new Uint8ClampedArray(src.data); // コピーして加工
  const d = out;
  const lo = low * 255, hi = high * 255;
  const outer = vertical ? w : h;
  const inner = vertical ? h : w;
  const idx = vertical
    ? (o, i) => (i * w + o) * 4
    : (o, i) => (o * w + i) * 4;

  const px = [];
  for (let o = 0; o < outer; o++) {
    let runStart = -1;
    for (let i = 0; i <= inner; i++) {
      const inRun = i < inner && (() => {
        const k = idx(o, i);
        const l = lumOf(d, k);
        return l >= lo && l <= hi;
      })();
      if (inRun && runStart < 0) runStart = i;
      if (!inRun && runStart >= 0) {
        const len = i - runStart;
        if (len > 4) {
          px.length = 0;
          for (let j = runStart; j < i; j++) {
            const k = idx(o, j);
            px.push([lumOf(d, k), d[k], d[k + 1], d[k + 2], d[k + 3]]);
          }
          px.sort((a, b) => a[0] - b[0]);
          for (let j = 0; j < len; j++) {
            const k = idx(o, runStart + j);
            d[k] = px[j][1]; d[k + 1] = px[j][2]; d[k + 2] = px[j][3]; d[k + 3] = px[j][4];
          }
        }
        runStart = -1;
      }
    }
  }
  return new ImageData(out, w, h);
}

let sortTimer = 0;
function scheduleSort() {
  clearTimeout(sortTimer);
  sortTimer = setTimeout(uploadSource, 60);
}

function uploadSource() {
  if (!originalData) return;
  let data = originalData;
  if (enabled.sort) {
    const lo = Math.min(state.sortLow, state.sortHigh);
    const hi = Math.max(state.sortLow, state.sortHigh);
    data = pixelSorted(originalData, lo, hi, state.sortVert === 1);
  }
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  markDirty();
}

// ---------------------------------------------------------------- image I/O

function setSourceImage(imgLike, w, h) {
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  W = Math.max(1, Math.round(w * scale));
  H = Math.max(1, Math.round(h * scale));
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.drawImage(imgLike, 0, 0, W, H);
  originalData = ctx.getImageData(0, 0, W, H);
  canvas.width = W;
  canvas.height = H;
  allocFbos(W, H);
  uploadSource();
  document.getElementById("status-res").textContent = `${W} × ${H} px`;
  document.getElementById("drop-hint").style.display = "none";
}

async function loadBlob(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    setSourceImage(bmp, bmp.width, bmp.height);
    bmp.close();
  } catch {
    setNote("画像を読み込めませんでした", true);
  }
}

const fileInput = document.getElementById("file-input");
document.getElementById("btn-open").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) loadBlob(fileInput.files[0]);
  fileInput.value = "";
});

const stage = document.getElementById("stage");
window.addEventListener("dragover", (e) => { e.preventDefault(); stage.classList.add("dragging"); });
window.addEventListener("dragleave", (e) => { if (!e.relatedTarget) stage.classList.remove("dragging"); });
window.addEventListener("drop", (e) => {
  e.preventDefault();
  stage.classList.remove("dragging");
  const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith("image/"));
  if (f) loadBlob(f);
});
window.addEventListener("paste", (e) => {
  const f = [...(e.clipboardData?.items || [])].find((x) => x.type.startsWith("image/"));
  if (f) loadBlob(f.getAsFile());
});

document.getElementById("btn-save").addEventListener("click", () => {
  if (!originalData) return;
  render(animate ? performance.now() / 1000 : frozenTime);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `noizlab_${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, "image/png");
});

document.getElementById("chk-anim").addEventListener("change", (e) => {
  animate = e.target.checked;
  if (!animate) frozenTime = performance.now() / 1000;
  markDirty();
});

// ---------------------------------------------------------------- AI 生成

const aiNote = document.getElementById("ai-note");
const aiBtn = document.getElementById("btn-generate");
const aiPrompt = document.getElementById("ai-prompt");

function setNote(msg, isError) {
  aiNote.textContent = msg;
  aiNote.classList.toggle("error", !!isError);
}

async function generate() {
  const prompt = aiPrompt.value.trim();
  if (!prompt) return;
  aiBtn.disabled = true;
  aiBtn.textContent = "生成中…";
  setNote("Workers AI で生成しています（10秒前後）…");
  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (res.status === 429) {
      setNote("リクエストが多すぎます。1分ほど待ってから再試行してください。", true);
      return;
    }
    if (!res.ok) throw new Error(`status ${res.status}`);
    const blob = await res.blob();
    await loadBlob(blob);
    setNote("生成完了。エフェクトをかけてみてください。");
  } catch {
    setNote("生成に失敗しました。少し待って再試行してください。", true);
  } finally {
    aiBtn.disabled = false;
    aiBtn.textContent = "生成";
  }
}
aiBtn.addEventListener("click", generate);
aiPrompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) generate();
});

// ---------------------------------------------------------------- render

function markDirty() { dirty = true; }

function pass(p, tex, target, setup) {
  gl.useProgram(p.prog);
  gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
  gl.viewport(0, 0, W, H);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(p.u.u_tex, 0);
  setup(p.u);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function render(time) {
  if (!originalData) return;

  let base = srcTex;
  const blurR = enabled.blur ? state.blur : 0;
  if (blurR > 0.25) {
    pass(blurP, base, fboA, (u) => {
      gl.uniform2f(u.u_dir, 1, 0); gl.uniform2f(u.u_res, W, H); gl.uniform1f(u.u_radius, blurR);
    });
    pass(blurP, fboA.tex, fboB, (u) => {
      gl.uniform2f(u.u_dir, 0, 1); gl.uniform2f(u.u_res, W, H); gl.uniform1f(u.u_radius, blurR);
    });
    base = fboB.tex;
  }

  let glow = blackTex;
  const hal = enabled.halation ? state.halation : 0;
  if (hal > 0.01) {
    const glowR = Math.min(40, Math.max(8, W * 0.012));
    pass(brightP, base, fboC, (u) => { gl.uniform1f(u.u_thresh, state.halThresh); });
    pass(blurP, fboC.tex, fboD, (u) => {
      gl.uniform2f(u.u_dir, 1, 0); gl.uniform2f(u.u_res, W, H); gl.uniform1f(u.u_radius, glowR);
    });
    pass(blurP, fboD.tex, fboC, (u) => {
      gl.uniform2f(u.u_dir, 0, 1); gl.uniform2f(u.u_res, W, H); gl.uniform1f(u.u_radius, glowR);
    });
    glow = fboC.tex;
  }

  gl.useProgram(finalP.prog);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, W, H);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, base);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, glow);
  const u = finalP.u;
  gl.uniform1i(u.u_base, 0);
  gl.uniform1i(u.u_glow, 1);
  gl.uniform2f(u.u_res, W, H);
  gl.uniform1f(u.u_time, time);
  gl.uniform1f(u.u_seed, seed);
  gl.uniform1f(u.u_glitch, enabled.glitch ? state.glitch : 0);
  gl.uniform1f(u.u_rgb, enabled.rgb ? state.rgb : 0);
  gl.uniform1f(u.u_halation, hal);
  gl.uniform1f(u.u_pixel, enabled.pixel ? state.pixel : 0);
  gl.uniform1i(u.u_dmode, enabled.dither ? state.dmode : 0);
  gl.uniform1f(u.u_dscale, state.dscale);
  gl.uniform1f(u.u_levels, state.levels);
  gl.uniform1f(u.u_curve, enabled.crt ? state.curve : 0);
  gl.uniform1f(u.u_scan, enabled.crt ? state.scan : 0);
  gl.uniform1f(u.u_noise, enabled.grain ? state.noise : 0);
  gl.uniform1f(u.u_vig, enabled.grain ? state.vig : 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function frame() {
  const needsAnim = animate && originalData &&
    ((enabled.glitch && state.glitch > 0) || (enabled.grain && state.noise > 0));
  if (dirty || needsAnim) {
    render(animate ? performance.now() / 1000 : frozenTime);
    dirty = false;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------- 初期サンプル画像

function makeSample() {
  const w = 1200, h = 800;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const x = c.getContext("2d");

  const g = x.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, "#1b2735");
  g.addColorStop(0.5, "#3a1c4f");
  g.addColorStop(1, "#0d0d10");
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);

  // 夕日
  const sun = x.createRadialGradient(w * 0.5, h * 0.42, 20, w * 0.5, h * 0.42, 260);
  sun.addColorStop(0, "#ffd76e");
  sun.addColorStop(0.4, "#ff7a3c");
  sun.addColorStop(1, "rgba(255,80,60,0)");
  x.fillStyle = sun;
  x.fillRect(0, 0, w, h);
  x.fillStyle = "#ffcf5c";
  x.beginPath();
  x.arc(w * 0.5, h * 0.42, 110, 0, Math.PI * 2);
  x.fill();

  // 地平グリッド
  x.strokeStyle = "rgba(200,255,0,0.55)";
  x.lineWidth = 2;
  const horizon = h * 0.62;
  for (let i = 0; i < 14; i++) {
    const t = i / 13;
    const y = horizon + (h - horizon) * t * t;
    x.beginPath(); x.moveTo(0, y); x.lineTo(w, y); x.stroke();
  }
  for (let i = -10; i <= 10; i++) {
    x.beginPath();
    x.moveTo(w / 2 + i * 60, horizon);
    x.lineTo(w / 2 + i * 260, h);
    x.stroke();
  }
  x.fillStyle = "rgba(10,10,16,0.35)";
  x.fillRect(0, horizon, w, h - horizon);

  // ビル影
  x.fillStyle = "#0c0e14";
  const bw = [90, 60, 130, 70, 110, 80, 100];
  let bx = 30;
  for (const width of bw) {
    const bh = 80 + ((bx * 7919) % 160);
    x.fillRect(bx, horizon - bh, width, bh);
    bx += width + 40;
  }

  x.font = "700 120px 'IBM Plex Mono', monospace";
  x.fillStyle = "#e8e6df";
  x.textAlign = "center";
  x.fillText("NOIZ", w / 2, h * 0.87);
  x.font = "28px 'DotGothic16', monospace";
  x.fillStyle = "#c8ff00";
  x.fillText("画像をドロップして加工開始", w / 2, h * 0.93);

  setSourceImage(c, w, h);
  document.getElementById("drop-hint").style.display = "";
}
makeSample();
applyPreset(PRESETS[1]); // 初期表示は Y2K プリセットでデモ
