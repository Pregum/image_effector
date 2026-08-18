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
uniform float u_temp;   // 色温度 -1..1
uniform float u_fade;   // 黒浮き 0..1
uniform float u_split;  // ティール&オレンジ 0..1
uniform float u_sat;    // 彩度 (1が等倍)
uniform float u_con;    // コントラスト (1が等倍)
uniform float u_leak;   // 光漏れ 0..1.5

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

  // カラーグレーディング（ハーフトーンがcolを再構成するためディザ類の後段に置く）
  col *= vec3(1.0 + u_temp * 0.12, 1.0 + u_temp * 0.03, 1.0 - u_temp * 0.12);
  col = col * (1.0 - u_fade * 0.28) + vec3(u_fade * 0.10, u_fade * 0.095, u_fade * 0.105);
  float lum2 = dot(col, vec3(0.299, 0.587, 0.114));
  vec3 st = mix(vec3(0.82, 1.02, 1.16), vec3(1.15, 1.0, 0.84), smoothstep(0.15, 0.85, lum2));
  col = mix(col, col * st, u_split);
  lum2 = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum2), col, u_sat);
  col = (col - 0.5) * u_con + 0.5;

  // 光漏れ（位置はシード依存。振り直しで移動する）
  if (u_leak > 0.0) {
    vec2 asp = vec2(u_res.x / u_res.y, 1.0);
    vec2 lp = vec2(0.86 + (hash(7.7) - 0.5) * 0.35, 0.24 + (hash(3.3) - 0.5) * 0.55);
    float dl = distance(uv * asp, lp * asp);
    float bloomL = exp(-dl * dl * 3.0);
    float streak = exp(-pow((uv.y - lp.y - 0.28) * 2.6, 2.0)) * 0.35;
    vec3 lc = mix(vec3(1.0, 0.45, 0.22), vec3(1.0, 0.30, 0.55), hash(9.1));
    col += (bloomL * 0.9 + streak) * u_leak * lc;
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
  temp: 0.25, fade: 0.35, split: 0.5, sat: 1.1, con: 1.1,
  leak: 0.7,
};
const DEFAULTS = { ...state };
const enabled = {
  blur: false, sort: false, glitch: false, rgb: false, halation: false,
  grade: false, leak: false,
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
  { id: "grade", name: "COLOR GRADE", jp: "色調エモ化",
    params: [
      { key: "temp", label: "色温度", min: -1, max: 1, step: 0.01 },
      { key: "fade", label: "フェード", min: 0, max: 1, step: 0.01 },
      { key: "split", label: "ティール&オレンジ", min: 0, max: 1, step: 0.01 },
      { key: "sat", label: "彩度", min: 0, max: 2, step: 0.01 },
      { key: "con", label: "コントラスト", min: 0.5, max: 1.6, step: 0.01 },
    ] },
  { id: "leak", name: "LIGHT LEAK", jp: "光漏れ", dice: true,
    params: [{ key: "leak", label: "強さ", min: 0, max: 1.5, step: 0.01 }] },
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
  { name: "CINEMA", on: { grade: 1, halation: 1, grain: 1 },
    set: { temp: 0.15, fade: 0.25, split: 0.75, sat: 1.05, con: 1.2,
           halation: 0.55, halThresh: 0.6, noise: 0.12, vig: 0.4 } },
  { name: "FILM", on: { grade: 1, leak: 1, grain: 1 },
    set: { temp: 0.4, fade: 0.55, split: 0.25, sat: 0.85, con: 0.95,
           leak: 0.85, noise: 0.3, vig: 0.3 } },
  { name: "NEON", on: { grade: 1, rgb: 1, halation: 1, crt: 1 },
    set: { temp: -0.25, fade: 0.1, split: 0.35, sat: 1.55, con: 1.2,
           rgb: 5, halation: 0.9, halThresh: 0.5, curve: 0, scan: 0.25 } },
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
  const pool = ["blur", "glitch", "rgb", "halation", "grade", "leak", "pixel", "dither", "crt", "grain", "sort"];
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
  state.temp = (Math.random() - 0.5) * 1.2;
  state.fade = Math.random() * 0.6;
  state.split = Math.random() * 0.9;
  state.sat = 0.8 + Math.random() * 0.8;
  state.con = 0.9 + Math.random() * 0.5;
  state.leak = 0.3 + Math.random();
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
  pendingParents = null; // 新しい画像の読み込みで系譜情報はリセット（掛け合わせ時は後から再設定）
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
    if (res.status === 503) {
      setNote("本日のAI生成の無料枠を使い切りました。日本時間 朝9時にリセットされます。", true);
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
    aiBtn.textContent = "写真";
  }
}
aiBtn.addEventListener("click", generate);
aiPrompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) generate();
});

// ---------------------------------------------------------------- AIシーン生成（ベクター風）

const HEX6 = /^#[0-9a-fA-F]{6}$/;
const pickCol = (c, fb) => (typeof c === "string" && HEX6.test(c) ? c : fb);
const pickNum = (v, lo, hi, fb) =>
  typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb;

// LLMが設計したシーン仕様(JSON)をCanvasでベクター風に描画する。
// 仕様は信用せず、全フィールドをクランプ・検証して不正値でも必ず描き切る。
function renderScene(specIn) {
  pendingParents = null;
  const spec = specIn && typeof specIn === "object" ? specIn : {};
  const w = 1200, h = 800;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const x = c.getContext("2d");
  const rnd = srand(1 + Math.floor(Math.random() * 1e6));

  // 空
  const skyCols = (Array.isArray(spec.sky) ? spec.sky : []).filter((s) => HEX6.test(String(s)));
  const sky = skyCols.length >= 2 ? skyCols.slice(0, 4) : ["#1b2735", "#3a1c4f", "#0d0d10"];
  const g = x.createLinearGradient(0, 0, 0, h);
  sky.forEach((cs, i) => g.addColorStop(i / (sky.length - 1), cs));
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);

  const horizon = pickNum(spec.horizon, 0.5, 0.9, 0.68) * h;

  // 星
  const stars = Math.round(pickNum(spec.stars, 0, 200, 0));
  for (let i = 0; i < stars; i++) {
    x.fillStyle = `rgba(255,255,255,${0.2 + rnd() * 0.6})`;
    x.fillRect(rnd() * w, rnd() * horizon * 0.9, 2, 2);
  }

  // オーロラ
  const aurora = spec.aurora && typeof spec.aurora === "object" ? spec.aurora : null;
  if (aurora) {
    const acolsRaw = (Array.isArray(aurora.colors) ? aurora.colors : []).filter((s) => HEX6.test(String(s)));
    const bands = (acolsRaw.length ? acolsRaw : ["#5dffb0", "#7a6bff"]).slice(0, 3);
    x.save();
    x.globalCompositeOperation = "lighter";
    bands.forEach((ac, bi) => {
      const baseY = h * (0.08 + bi * 0.09);
      x.beginPath();
      x.moveTo(0, baseY);
      for (let px = 0; px <= w; px += 16) {
        const t = px / w;
        x.lineTo(px, baseY + Math.sin(t * 4 + bi * 1.7) * 36 + Math.sin(t * 9 + bi) * 14);
      }
      for (let px = w; px >= 0; px -= 16) {
        const t = px / w;
        x.lineTo(px, baseY + 140 + Math.sin(t * 4 + bi * 1.7 + 0.6) * 30);
      }
      x.closePath();
      const agr = x.createLinearGradient(0, baseY, 0, baseY + 160);
      agr.addColorStop(0, ac + "00");
      agr.addColorStop(0.4, ac + "38");
      agr.addColorStop(1, ac + "00");
      x.fillStyle = agr;
      x.fill();
    });
    x.restore();
  }

  // 太陽・月
  const cel = spec.celestial && typeof spec.celestial === "object" ? spec.celestial : {};
  const celType = cel.type === "moon" || cel.type === "none" ? cel.type : "sun";
  const cx = pickNum(cel.x, 0.05, 0.95, 0.5) * w;
  const cy = Math.min(pickNum(cel.y, 0.08, 0.9, 0.4) * h, horizon - 24);
  const cr = pickNum(cel.r, 0.03, 0.16, 0.08) * w;
  const celCol = pickCol(cel.color, celType === "moon" ? "#ffeecf" : "#ffd76e");
  const glowCol = pickCol(cel.glow, celType === "moon" ? "#ffe0aa" : "#ff7a3c");
  if (celType !== "none") {
    const cg = x.createRadialGradient(cx, cy, cr * 0.4, cx, cy, cr * 3.2);
    cg.addColorStop(0, glowCol + "e6");
    cg.addColorStop(0.3, glowCol + "59");
    cg.addColorStop(1, glowCol + "00");
    x.fillStyle = cg;
    x.fillRect(0, 0, w, h);
    x.fillStyle = celCol;
    x.beginPath(); x.arc(cx, cy, cr, 0, Math.PI * 2); x.fill();
    if (celType === "moon") {
      x.fillStyle = "rgba(120,100,90,0.25)";
      x.beginPath(); x.arc(cx - cr * 0.3, cy - cr * 0.15, cr * 0.18, 0, Math.PI * 2); x.fill();
      x.beginPath(); x.arc(cx + cr * 0.2, cy + cr * 0.25, cr * 0.12, 0, Math.PI * 2); x.fill();
    }
  }

  // 雲
  const clouds = spec.clouds && typeof spec.clouds === "object" ? spec.clouds : {};
  const cloudN = Math.round(pickNum(clouds.count, 0, 10, 0));
  const cloudCol = pickCol(clouds.color, "#282250");
  for (let i = 0; i < cloudN; i++) {
    x.globalAlpha = 0.35 + rnd() * 0.3;
    x.fillStyle = cloudCol;
    x.beginPath();
    x.ellipse(rnd() * w, h * (0.12 + rnd() * 0.4), 130 + rnd() * 240, 12 + rnd() * 12, 0, 0, Math.PI * 2);
    x.fill();
  }
  x.globalAlpha = 1;

  // 花火
  for (const f of (Array.isArray(spec.fireworks) ? spec.fireworks : []).slice(0, 4)) {
    if (!f || typeof f !== "object") continue;
    const fx = pickNum(f.x, 0.05, 0.95, 0.5) * w;
    const fy = pickNum(f.y, 0.05, 0.6, 0.25) * h;
    const fr = pickNum(f.r, 0.04, 0.18, 0.09) * w;
    const fc = pickCol(f.color, "#ffb75d");
    x.save();
    x.globalCompositeOperation = "lighter";
    const fg = x.createRadialGradient(fx, fy, 2, fx, fy, fr);
    fg.addColorStop(0, fc + "59");
    fg.addColorStop(1, fc + "00");
    x.fillStyle = fg;
    x.fillRect(fx - fr, fy - fr, fr * 2, fr * 2);
    x.strokeStyle = fc;
    x.lineWidth = 1.6;
    const rays = 26;
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2 + rnd() * 0.12;
      const len = fr * (0.7 + rnd() * 0.35);
      x.globalAlpha = 0.45 + rnd() * 0.45;
      x.beginPath();
      x.moveTo(fx + Math.cos(a) * fr * 0.12, fy + Math.sin(a) * fr * 0.12);
      x.lineTo(fx + Math.cos(a) * len, fy + Math.sin(a) * len);
      x.stroke();
      x.fillStyle = fc;
      x.beginPath();
      x.arc(fx + Math.cos(a) * len, fy + Math.sin(a) * len, 2.2, 0, Math.PI * 2);
      x.fill();
    }
    x.restore();
  }

  // 地面
  const ground = spec.ground && typeof spec.ground === "object" ? spec.ground : {};
  const gcols = (Array.isArray(ground.colors) ? ground.colors : []).filter((s) => HEX6.test(String(s)));
  const gtype = ["sea", "grid", "mountains", "city", "plain"].includes(ground.type)
    ? ground.type : "plain";
  if (gtype === "sea") {
    x.fillStyle = gcols[0] || "#10122c";
    x.fillRect(0, horizon, w, h - horizon);
    for (let i = 0; i < 90; i++) {
      x.fillStyle = `rgba(255,255,255,${0.03 + rnd() * 0.07})`;
      x.fillRect(rnd() * w, horizon + rnd() * (h - horizon), 20 + rnd() * 120, 2);
    }
    if (celType !== "none") {
      for (let i = 0; i < 44; i++) {
        const ly = horizon + (i / 44) * (h - horizon);
        const spread = 20 + i * 3.4;
        const lw = 12 + rnd() * spread;
        x.fillStyle = glowCol + "4d";
        x.fillRect(cx - lw / 2 + (rnd() - 0.5) * spread * 0.7, ly, lw, 2.4);
      }
    }
  } else if (gtype === "grid") {
    x.fillStyle = "rgba(8,8,14,0.55)";
    x.fillRect(0, horizon, w, h - horizon);
    x.strokeStyle = (gcols[0] || "#c8ff00") + "8c";
    x.lineWidth = 2;
    for (let i = 0; i < 14; i++) {
      const t = i / 13;
      const yv = horizon + (h - horizon) * t * t;
      x.beginPath(); x.moveTo(0, yv); x.lineTo(w, yv); x.stroke();
    }
    for (let i = -10; i <= 10; i++) {
      x.beginPath();
      x.moveTo(w / 2 + i * 60, horizon);
      x.lineTo(w / 2 + i * 260, h);
      x.stroke();
    }
  } else if (gtype === "mountains") {
    const layers = (gcols.length ? gcols : ["#7a3f66", "#54305c", "#331f47"]).slice(0, 4);
    layers.forEach((lc, li) => {
      const base = horizon / h + (li + 1) * ((0.97 - horizon / h) / layers.length);
      x.fillStyle = lc;
      x.beginPath();
      x.moveTo(0, h);
      for (let px = 0; px <= w; px += 8) {
        const t = px / w;
        const yv = h * base -
          Math.abs(Math.sin(t * 4.4 + li * 2.1) + Math.sin(t * 9.7 + li)) * (60 + li * 18) -
          Math.sin(t * 23 + li * 5) * 8;
        x.lineTo(px, yv);
      }
      x.lineTo(w, h);
      x.closePath();
      x.fill();
    });
  } else if (gtype === "city") {
    x.fillStyle = "rgba(8,8,14,0.4)";
    x.fillRect(0, horizon, w, h - horizon);
    const sil = gcols[0] || "#0b0b14";
    let bx = -20;
    while (bx < w) {
      const bw = 60 + rnd() * 110;
      const bh = h * (0.12 + rnd() * 0.3);
      x.fillStyle = sil;
      x.fillRect(bx, horizon - bh, bw, bh + (h - horizon) * 0.4);
      for (let wy = horizon - bh + 14; wy < horizon - 8; wy += 24) {
        for (let wx = bx + 8; wx < bx + bw - 10; wx += 20) {
          if (rnd() < 0.3) {
            x.fillStyle = rnd() < 0.6 ? "rgba(255,209,102,0.7)" : "rgba(120,220,255,0.5)";
            x.fillRect(wx, wy, 7, 10);
          }
        }
      }
      bx += bw + 8 + rnd() * 30;
    }
    x.fillStyle = "rgba(8,8,14,0.85)";
    x.fillRect(0, horizon + (h - horizon) * 0.4, w, (h - horizon) * 0.6);
  } else {
    x.fillStyle = gcols[0] || "#141230";
    x.fillRect(0, horizon, w, h - horizon);
    for (let i = 0; i < 40; i++) {
      x.fillStyle = `rgba(255,255,255,${0.02 + rnd() * 0.05})`;
      x.fillRect(rnd() * w, horizon + rnd() * (h - horizon), 40 + rnd() * 200, 2);
    }
  }

  // 鳥居（シルエット）
  const torii = spec.torii && typeof spec.torii === "object" ? spec.torii : null;
  if (torii) {
    const ts = pickNum(torii.size, 0.1, 0.6, 0.32) * h;
    const tx = pickNum(torii.x, 0.1, 0.9, 0.5) * w;
    const tcol = pickCol(torii.color, "#2e0f1c");
    const baseY = horizon + (h - horizon) * 0.3;
    const wT = ts * 1.25;
    x.fillStyle = tcol;
    // 柱
    x.fillRect(tx - wT * 0.4, baseY - ts * 0.78, ts * 0.075, ts * 0.78);
    x.fillRect(tx + wT * 0.4 - ts * 0.075, baseY - ts * 0.78, ts * 0.075, ts * 0.78);
    // 笠木（上部の反り）
    x.beginPath();
    x.moveTo(tx - wT * 0.52, baseY - ts * 0.8);
    x.quadraticCurveTo(tx, baseY - ts * 0.88, tx + wT * 0.52, baseY - ts * 0.8);
    x.lineTo(tx + wT * 0.54, baseY - ts * 0.93);
    x.quadraticCurveTo(tx, baseY - ts * 1.02, tx - wT * 0.54, baseY - ts * 0.93);
    x.closePath();
    x.fill();
    // 貫と額束
    x.fillRect(tx - wT * 0.45, baseY - ts * 0.62, wT * 0.9, ts * 0.055);
    x.fillRect(tx - ts * 0.032, baseY - ts * 0.8, ts * 0.064, ts * 0.19);
  }

  // 鳥
  const birds = Math.round(pickNum(spec.birds, 0, 12, 0));
  x.strokeStyle = "rgba(20,14,30,0.85)";
  x.lineWidth = 2.4;
  for (let i = 0; i < birds; i++) {
    const bx = w * (0.15 + rnd() * 0.7), by = h * (0.12 + rnd() * 0.3), s = 7 + rnd() * 9;
    x.beginPath();
    x.moveTo(bx - s, by);
    x.quadraticCurveTo(bx - s * 0.4, by - s * 0.7, bx, by);
    x.quadraticCurveTo(bx + s * 0.4, by - s * 0.7, bx + s, by);
    x.stroke();
  }

  // ネオンサイン
  for (const s of (Array.isArray(spec.signs) ? spec.signs : []).slice(0, 4)) {
    if (!s || typeof s !== "object") continue;
    const t = typeof s.text === "string" ? s.text.slice(0, 6) : "";
    if (!t) continue;
    const scol = pickCol(s.color, "#ff3ea5");
    const sx = pickNum(s.x, 0.06, 0.94, 0.5) * w;
    const sy = pickNum(s.y, 0.1, 0.75, 0.3) * h;
    x.save();
    x.font = "42px 'DotGothic16', monospace";
    x.textAlign = "center";
    x.shadowColor = scol;
    x.shadowBlur = 26;
    x.fillStyle = scol;
    x.fillText(t, sx, sy);
    x.globalAlpha = 0.55;
    x.strokeStyle = scol;
    x.lineWidth = 2;
    const bw = Math.max(96, t.length * 46);
    x.strokeRect(sx - bw / 2, sy - 42, bw, 58);
    x.restore();
  }

  // 桜の花びら
  const sakura = Math.round(pickNum(spec.sakura, 0, 150, 0));
  for (let i = 0; i < sakura; i++) {
    const px = rnd() * w, py = rnd() * h, sz = 3 + rnd() * 6;
    x.save();
    x.translate(px, py);
    x.rotate(rnd() * Math.PI);
    x.fillStyle = `rgba(255,${170 + Math.floor(rnd() * 40)},${195 + Math.floor(rnd() * 30)},${0.5 + rnd() * 0.4})`;
    x.beginPath();
    x.ellipse(0, 0, sz, sz * 0.6, 0, 0, Math.PI * 2);
    x.fill();
    x.restore();
  }

  // 雪
  const snow = Math.round(pickNum(spec.snow, 0, 240, 0));
  for (let i = 0; i < snow; i++) {
    x.fillStyle = `rgba(255,255,255,${0.35 + rnd() * 0.5})`;
    x.beginPath();
    x.arc(rnd() * w, rnd() * h, 1 + rnd() * 2.6, 0, Math.PI * 2);
    x.fill();
  }

  // 雨
  const rain = Math.round(pickNum(spec.rain, 0, 240, 0));
  x.strokeStyle = "rgba(200,215,255,0.18)";
  x.lineWidth = 1;
  for (let i = 0; i < rain; i++) {
    const rx = rnd() * w, ry = rnd() * h, len = 14 + rnd() * 18;
    x.beginPath(); x.moveTo(rx, ry); x.lineTo(rx - 3, ry + len); x.stroke();
  }

  setSourceImage(c, w, h);
  document.getElementById("drop-hint").style.display = "";
}

const sceneBtn = document.getElementById("btn-scene");
async function generateScene() {
  const prompt = aiPrompt.value.trim();
  if (!prompt) return;
  sceneBtn.disabled = true;
  sceneBtn.textContent = "描画中…";
  try {
    const res = await fetch("/api/scene", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (res.status === 429) {
      setNote("リクエストが多すぎます。1分ほど待ってから再試行してください。", true);
      return;
    }
    if (res.status === 503) {
      setNote("本日のAI生成の無料枠を使い切りました。日本時間 朝9時にリセットされます。", true);
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    const { spec } = await res.json();
    renderScene(spec);
    setNote("シーンを描画しました。エフェクトをかけてみてください。");
  } catch {
    setNote("シーン生成に失敗しました。再試行してください。", true);
  } finally {
    sceneBtn.disabled = false;
    sceneBtn.textContent = "シーン";
  }
}
sceneBtn.addEventListener("click", generateScene);

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
  gl.uniform1f(u.u_temp, enabled.grade ? state.temp : 0);
  gl.uniform1f(u.u_fade, enabled.grade ? state.fade : 0);
  gl.uniform1f(u.u_split, enabled.grade ? state.split : 0);
  gl.uniform1f(u.u_sat, enabled.grade ? state.sat : 1);
  gl.uniform1f(u.u_con, enabled.grade ? state.con : 1);
  gl.uniform1f(u.u_leak, enabled.leak ? state.leak : 0);
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

// ---------------------------------------------------------------- ギャラリー

const galleryOverlay = document.getElementById("gallery-overlay");
const galleryGrid = document.getElementById("gallery-grid");
const galleryNote = document.getElementById("gallery-note");
const galleryKeyInput = document.getElementById("gallery-key");
const btnStore = document.getElementById("btn-store");

const galleryKey = () => (localStorage.getItem("nl_gallery_key") || "").trim();
galleryKeyInput.value = galleryKey();
galleryKeyInput.addEventListener("change", () => {
  localStorage.setItem("nl_gallery_key", galleryKeyInput.value.trim());
  refreshGallery();
});

function setGalleryNote(msg, isError) {
  galleryNote.textContent = msg;
  galleryNote.classList.toggle("error", !!isError);
}

function openGallery() {
  galleryOverlay.hidden = false;
  refreshGallery().then(() => { if (graphMode) startGraph(); });
}
function closeGallery() { galleryOverlay.hidden = true; }
document.getElementById("btn-gallery").addEventListener("click", openGallery);
document.getElementById("gallery-close").addEventListener("click", closeGallery);
galleryOverlay.addEventListener("click", (e) => { if (e.target === galleryOverlay) closeGallery(); });

const toBlobAsync = (c, type, quality) =>
  new Promise((resolve) => c.toBlob(resolve, type, quality));

function currentRecipe() {
  return { enabled: { ...enabled }, state: { ...state }, seed };
}

async function saveToGallery() {
  if (!originalData) return;
  if (!galleryKey()) {
    openGallery();
    setGalleryNote("先にアクセスキーを入力してください。", true);
    return;
  }
  const orig = "ギャラリーへ保存";
  btnStore.disabled = true;
  btnStore.textContent = "保存中…";
  let result = "保存失敗";
  try {
    // 元画像（レシピと合わせて保存し、再編集可能にする）
    const sc = document.createElement("canvas");
    sc.width = W; sc.height = H;
    sc.getContext("2d").putImageData(originalData, 0, 0);
    const source = await toBlobAsync(sc, "image/webp", 0.92);
    // レンダリング結果のサムネイル
    render(animate ? performance.now() / 1000 : frozenTime);
    const scale = Math.min(1, 360 / W);
    const tc = document.createElement("canvas");
    tc.width = Math.max(1, Math.round(W * scale));
    tc.height = Math.max(1, Math.round(H * scale));
    tc.getContext("2d").drawImage(canvas, 0, 0, tc.width, tc.height);
    const thumb = await toBlobAsync(tc, "image/webp", 0.85);

    const fd = new FormData();
    fd.append("source", source, "source");
    fd.append("thumb", thumb, "thumb");
    fd.append("meta", JSON.stringify({
      recipe: currentRecipe(),
      prompt: aiPrompt.value.trim() || null,
      width: W,
      height: H,
      parents: pendingParents || undefined,
    }));
    const res = await fetch("/api/works", {
      method: "POST",
      headers: { "x-gallery-key": galleryKey() },
      body: fd,
    });
    if (res.status === 401) {
      openGallery();
      setGalleryNote("アクセスキーが違います。", true);
    } else if (res.status === 429) {
      result = "保存が多すぎます";
    } else if (res.ok) {
      result = pendingParents ? "保存・系譜記録 ✓" : "保存しました ✓";
      pendingParents = null; // 二重記録を防ぐ
    }
  } catch { /* result は保存失敗のまま */ }
  btnStore.textContent = result;
  btnStore.disabled = false;
  setTimeout(() => { btnStore.textContent = orig; }, 1800);
}
btnStore.addEventListener("click", saveToGallery);

let lastWorks = [];

async function refreshGallery() {
  if (!galleryKey()) {
    galleryGrid.innerHTML = "";
    setGalleryNote("アクセスキーを入力すると一覧が表示されます。");
    return;
  }
  setGalleryNote("読み込み中…");
  try {
    const res = await fetch("/api/works", { headers: { "x-gallery-key": galleryKey() } });
    if (res.status === 401) {
      galleryGrid.innerHTML = "";
      setGalleryNote("アクセスキーが違います。", true);
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    const { works } = await res.json();
    lastWorks = works;
    galleryGrid.innerHTML = "";
    if (!works.length) {
      setGalleryNote("まだ作品がありません。「ギャラリーへ保存」で追加できます。");
      return;
    }
    setGalleryNote(`${works.length}件の作品。クリックで読み込み。`);
    for (const w of works) {
      const el = document.createElement("div");
      el.className = "work";
      const dt = new Date(w.created_at);
      const label = `${dt.getMonth() + 1}/${dt.getDate()} ` +
        `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
      el.innerHTML =
        `<img loading="lazy" src="/api/works/${w.id}/thumb" alt="" />` +
        `<div class="work-meta"><span>${label}</span><button class="work-del" title="削除">✕</button></div>`;
      el.querySelector("img").addEventListener("click", () => loadWork(w));
      el.querySelector(".work-del").addEventListener("click", async (e) => {
        e.stopPropagation();
        await fetch(`/api/works/${w.id}`, {
          method: "DELETE",
          headers: { "x-gallery-key": galleryKey() },
        });
        refreshGallery();
      });
      galleryGrid.appendChild(el);
    }
  } catch {
    setGalleryNote("一覧の取得に失敗しました。", true);
  }
}

async function loadWork(w) {
  try {
    // レシピを先に適用（ピクセルソートはソース読み込み時に反映されるため）
    Object.assign(state, DEFAULTS, w.recipe.state);
    for (const k of Object.keys(enabled)) enabled[k] = !!w.recipe.enabled?.[k];
    seed = w.recipe.seed ?? 1;
    syncUI();
    const res = await fetch(`/api/works/${w.id}/source`);
    if (!res.ok) throw new Error(String(res.status));
    await loadBlob(await res.blob());
    closeGallery();
  } catch {
    setGalleryNote("読み込みに失敗しました。", true);
  }
}

// ---------------------------------------------------------------- ナレッジグラフ

let pendingParents = null; // 掛け合わせ・変異で生まれた子の親ID（保存時に系譜として記録）

const graphWrap = document.getElementById("graph-wrap");
const graphCanvas = document.getElementById("graph-canvas");
const gctx = graphCanvas.getContext("2d");
const graphActions = document.getElementById("graph-actions");
const viewToggle = document.getElementById("gallery-view-toggle");

let graphMode = false;
let gNodes = [];
let gEdges = [];   // 類似エッジ {a, b, w}
let gLineage = []; // 系譜エッジ {a, b}
let gSel = [];     // 選択中ノードID（最大2）
let g3d = false;
let gYaw = 0, gPitch = 0, gPanX = 0, gPanY = 0, gZoom = 1;
const thumbCache = new Map();

document.getElementById("chk-3d").addEventListener("change", (e) => {
  g3d = e.target.checked;
  if (!g3d) { gYaw = 0; gPitch = 0; }
});

viewToggle.addEventListener("click", () => {
  graphMode = !graphMode;
  viewToggle.textContent = graphMode ? "▤ 一覧" : "◈ グラフ";
  galleryGrid.hidden = graphMode;
  graphWrap.hidden = !graphMode;
  if (graphMode) startGraph();
});

function startGraph() {
  buildGraph();
  requestAnimationFrame(graphFrame);
  repairEmbeddings();
}

function buildGraph() {
  const works = lastWorks.filter((w) => w.recipe);
  const prev = new Map(gNodes.map((n) => [n.id, n]));
  gNodes = works.map((w) => {
    let img = thumbCache.get(w.id);
    if (!img) {
      img = new Image();
      img.src = `/api/works/${w.id}/thumb`;
      thumbCache.set(w.id, img);
    }
    const old = prev.get(w.id);
    if (old) return Object.assign(old, { work: w });
    return {
      id: w.id, work: w, img,
      x: (Math.random() - 0.5) * 320,
      y: (Math.random() - 0.5) * 320,
      z: (Math.random() - 0.5) * 320,
      vx: 0, vy: 0, vz: 0,
      sx: 0, sy: 0, sr: 0, hidden: true,
    };
  });
  gSel = gSel.filter((id) => gNodes.some((n) => n.id === id));
  computeEdges();
  sizeGraphCanvas();
  updateActions();
}

function sizeGraphCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = graphCanvas.clientWidth;
  const h = graphCanvas.clientHeight;
  if (w && h) {
    graphCanvas.width = w * dpr;
    graphCanvas.height = h * dpr;
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

function cosine(a, b) {
  let s = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na * nb);
  return d > 0 ? s / d : 0;
}

// レシピを正規化ベクトル化（ON/OFF重み + 各パラメータの0..1値）
function recipeVec(recipe) {
  const v = [];
  for (const mod of MODULES) {
    const on = recipe?.enabled?.[mod.id] ? 1 : 0;
    v.push(on * 2);
    for (const p of mod.params) {
      const val = recipe?.state?.[p.key] ?? DEFAULTS[p.key];
      v.push(on * ((val - p.min) / (p.max - p.min)));
    }
    if (mod.seg) v.push(on * (recipe?.state?.[mod.seg.key] ?? 0) * 0.5);
  }
  return v;
}

function computeEdges() {
  const N = gNodes.length;
  const rvecs = gNodes.map((n) => recipeVec(n.work.recipe));
  const sim = Array.from({ length: N }, () => new Float32Array(N));
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const a = gNodes[i].work, b = gNodes[j].work;
      const rs = Math.max(0, cosine(rvecs[i], rvecs[j]));
      let s;
      if (Array.isArray(a.embedding) && Array.isArray(b.embedding)) {
        // bge系のcosineは0.55〜0.95に集まるので広げて0..1へ
        const es = Math.min(1, Math.max(0, (cosine(a.embedding, b.embedding) - 0.55) / 0.4));
        s = 0.6 * es + 0.4 * rs;
      } else {
        s = rs * 0.8;
      }
      sim[i][j] = sim[j][i] = s;
    }
  }
  const pairs = new Set();
  gEdges = [];
  for (let i = 0; i < N; i++) {
    const order = [...Array(N).keys()]
      .filter((j) => j !== i)
      .sort((x, y) => sim[i][y] - sim[i][x])
      .slice(0, 3);
    for (const j of order) {
      if (sim[i][j] < 0.3) continue;
      const key = Math.min(i, j) + ":" + Math.max(i, j);
      if (pairs.has(key)) continue;
      pairs.add(key);
      gEdges.push({ a: Math.min(i, j), b: Math.max(i, j), w: sim[i][j] });
    }
  }
  const idx = new Map(gNodes.map((n, i) => [n.id, i]));
  gLineage = [];
  gNodes.forEach((n, i) => {
    for (const p of [n.work.parent_a, n.work.parent_b]) {
      if (p && idx.has(p)) gLineage.push({ a: idx.get(p), b: i });
    }
  });
}

function stepSim() {
  const N = gNodes.length;
  for (let i = 0; i < N; i++) {
    const a = gNodes[i];
    for (let j = i + 1; j < N; j++) {
      const b = gNodes[j];
      let dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      const d2 = dx * dx + dy * dy + dz * dz + 0.01;
      const f = Math.min(8, 18000 / d2);
      const d = Math.sqrt(d2);
      dx /= d; dy /= d; dz /= d;
      a.vx += dx * f; a.vy += dy * f; a.vz += dz * f;
      b.vx -= dx * f; b.vy -= dy * f; b.vz -= dz * f;
    }
  }
  const springs = [];
  for (const e of gEdges) springs.push({ a: e.a, b: e.b, rest: 320 - 240 * e.w, k: 0.005 + 0.02 * e.w });
  for (const e of gLineage) springs.push({ a: e.a, b: e.b, rest: 130, k: 0.03 });
  for (const s of springs) {
    const a = gNodes[s.a], b = gNodes[s.b];
    let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const f = (d - s.rest) * s.k;
    dx /= d; dy /= d; dz /= d;
    a.vx += dx * f; a.vy += dy * f; a.vz += dz * f;
    b.vx -= dx * f; b.vy -= dy * f; b.vz -= dz * f;
  }
  for (const n of gNodes) {
    n.vx -= n.x * 0.002; n.vy -= n.y * 0.002; n.vz -= n.z * 0.002;
    n.vx *= 0.85; n.vy *= 0.85; n.vz *= 0.85;
    n.x += n.vx; n.y += n.vy; n.z += n.vz;
    if (!g3d) { n.z *= 0.8; n.vz = 0; }
  }
}

function project(n, cw, ch) {
  const cy = Math.cos(gYaw), sy = Math.sin(gYaw);
  const cp = Math.cos(gPitch), sp = Math.sin(gPitch);
  const x = n.x * cy + n.z * sy;
  let z = -n.x * sy + n.z * cy;
  const y = n.y * cp - z * sp;
  z = n.y * sp + z * cp;
  const f = 700;
  if (z < -f + 60) return null; // カメラ背後は描画しない
  const s = (f / (f + z)) * gZoom;
  return { sx: cw / 2 + gPanX + x * s, sy: ch / 2 + gPanY + y * s, s, z };
}

function drawGraph() {
  const cw = graphCanvas.clientWidth, ch = graphCanvas.clientHeight;
  gctx.clearRect(0, 0, cw, ch);
  const proj = gNodes.map((n) => project(n, cw, ch));

  for (const e of gEdges) {
    const a = proj[e.a], b = proj[e.b];
    if (!a || !b) continue;
    gctx.strokeStyle = `rgba(200,255,0,${(0.08 + e.w * 0.35).toFixed(3)})`;
    gctx.lineWidth = 1;
    gctx.beginPath(); gctx.moveTo(a.sx, a.sy); gctx.lineTo(b.sx, b.sy); gctx.stroke();
  }
  for (const e of gLineage) {
    const a = proj[e.a], b = proj[e.b];
    if (!a || !b) continue;
    gctx.strokeStyle = "rgba(255,62,165,0.75)";
    gctx.lineWidth = 1.6;
    gctx.setLineDash([6, 4]);
    gctx.beginPath(); gctx.moveTo(a.sx, a.sy); gctx.lineTo(b.sx, b.sy); gctx.stroke();
    gctx.setLineDash([]);
  }

  const order = [...gNodes.keys()].filter((i) => proj[i]).sort((i, j) => proj[j].z - proj[i].z);
  gNodes.forEach((n, i) => { n.hidden = !proj[i]; });
  for (const i of order) {
    const n = gNodes[i], p = proj[i];
    const w = 56 * p.s, h = w * 0.75;
    n.sx = p.sx; n.sy = p.sy; n.sr = w / 2;
    const x = p.sx - w / 2, y = p.sy - h / 2;
    if (n.img.complete && n.img.naturalWidth) {
      gctx.drawImage(n.img, x, y, w, h);
    } else {
      gctx.fillStyle = "#151a11";
      gctx.fillRect(x, y, w, h);
    }
    const si = gSel.indexOf(n.id);
    gctx.strokeStyle = si >= 0 ? "#c8ff00" : "rgba(255,255,255,0.18)";
    gctx.lineWidth = si >= 0 ? 2 : 1;
    gctx.strokeRect(x, y, w, h);
    if (si >= 0) {
      gctx.fillStyle = "#c8ff00";
      gctx.font = "bold 11px monospace";
      gctx.fillText(si === 0 ? "A" : "B", x + 4, y + 13);
    }
  }
}

function graphFrame() {
  if (galleryOverlay.hidden || !graphMode) return;
  stepSim();
  drawGraph();
  requestAnimationFrame(graphFrame);
}

// --- 操作（クリック選択 / ドラッグ回転・移動 / ホイールズーム）
let pDown = null;
let pDragging = false;
graphCanvas.addEventListener("pointerdown", (e) => {
  pDown = { x: e.clientX, y: e.clientY };
  pDragging = false;
  graphCanvas.setPointerCapture(e.pointerId);
});
graphCanvas.addEventListener("pointermove", (e) => {
  if (!pDown) return;
  const dx = e.clientX - pDown.x, dy = e.clientY - pDown.y;
  if (!pDragging && Math.hypot(dx, dy) > 4) pDragging = true;
  if (pDragging) {
    if (g3d) {
      gYaw += dx * 0.005;
      gPitch = Math.max(-1.3, Math.min(1.3, gPitch + dy * 0.005));
    } else {
      gPanX += dx;
      gPanY += dy;
    }
    pDown = { x: e.clientX, y: e.clientY };
  }
});
graphCanvas.addEventListener("pointerup", (e) => {
  if (pDown && !pDragging) selectAt(e.offsetX, e.offsetY);
  pDown = null;
  pDragging = false;
});
graphCanvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  gZoom = Math.max(0.35, Math.min(2.5, gZoom * (e.deltaY > 0 ? 0.92 : 1.08)));
}, { passive: false });

function selectAt(mx, my) {
  let best = null, bestD = Infinity;
  for (const n of gNodes) {
    if (n.hidden) continue;
    const dx = mx - n.sx, dy = my - n.sy;
    if (Math.abs(dx) <= n.sr && Math.abs(dy) <= n.sr * 0.75) {
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = n; }
    }
  }
  if (!best) return;
  const i = gSel.indexOf(best.id);
  if (i >= 0) gSel.splice(i, 1);
  else {
    gSel.push(best.id);
    if (gSel.length > 2) gSel.shift();
  }
  updateActions();
}

const nodeById = (id) => gNodes.find((n) => n.id === id);

function updateActions() {
  graphActions.innerHTML = "";
  const mk = (label, fn) => {
    const b = document.createElement("button");
    b.className = "btn";
    b.textContent = label;
    b.addEventListener("click", fn);
    graphActions.appendChild(b);
  };
  if (gSel.length === 1) {
    const n = nodeById(gSel[0]);
    mk("開く", () => loadWork(n.work));
    mk("⚡ 突然変異", () => spawnChild(mutateRecipe(n.work.recipe), n.work, [n.work.id]));
    if (n.work.caption) setGalleryNote(`“${n.work.caption}”`);
  } else if (gSel.length === 2) {
    const a = nodeById(gSel[0]);
    const b = nodeById(gSel[1]);
    mk("◇ 掛け合わせ", () =>
      spawnChild(crossRecipes(a.work.recipe, b.work.recipe), a.work, [a.work.id, b.work.id]));
    setGalleryNote("掛け合わせ: A(先に選択)の元画像に、AとBを混ぜたレシピを適用します。");
  }
}

// --- レシピの交叉・突然変異（パラメータはmin/maxへクランプ）
const clampParam = (p, v) => Math.min(p.max, Math.max(p.min, v));

function crossRecipes(ra, rb) {
  const en = {};
  const st = { ...DEFAULTS };
  for (const mod of MODULES) {
    const a = !!ra?.enabled?.[mod.id];
    const b = !!rb?.enabled?.[mod.id];
    en[mod.id] = a && b ? true : a || b ? Math.random() < 0.7 : false;
    const t = 0.35 + Math.random() * 0.3;
    for (const p of mod.params) {
      const va = ra?.state?.[p.key] ?? DEFAULTS[p.key];
      const vb = rb?.state?.[p.key] ?? DEFAULTS[p.key];
      let v = va + (vb - va) * t + (Math.random() - 0.5) * 0.1 * (p.max - p.min);
      if (p.step >= 1) v = Math.round(v);
      st[p.key] = clampParam(p, v);
    }
    if (mod.seg) {
      const src = Math.random() < 0.5 ? ra : rb;
      st[mod.seg.key] = src?.state?.[mod.seg.key] ?? DEFAULTS[mod.seg.key];
    }
  }
  return { enabled: en, state: st, seed: Math.random() * 100 };
}

function mutateRecipe(r) {
  const en = {};
  const st = { ...DEFAULTS, ...(r?.state ?? {}) };
  for (const mod of MODULES) {
    en[mod.id] = !!r?.enabled?.[mod.id];
    if (Math.random() < 0.18) en[mod.id] = !en[mod.id];
    for (const p of mod.params) {
      let v = (st[p.key] ?? DEFAULTS[p.key]) +
        (en[mod.id] ? (Math.random() - 0.5) * 0.35 * (p.max - p.min) : 0);
      if (p.step >= 1) v = Math.round(v);
      st[p.key] = clampParam(p, v);
    }
  }
  return { enabled: en, state: st, seed: Math.random() * 100 };
}

async function spawnChild(recipe, baseWork, parents) {
  try {
    // レシピを先に適用（ピクセルソートはソース読み込み時に反映されるため）
    Object.assign(state, DEFAULTS, recipe.state);
    for (const k of Object.keys(enabled)) enabled[k] = !!recipe.enabled[k];
    seed = recipe.seed ?? Math.random() * 100;
    syncUI();
    const res = await fetch(`/api/works/${baseWork.id}/source`);
    if (!res.ok) throw new Error(String(res.status));
    await loadBlob(await res.blob());
    pendingParents = parents;
    gSel = [];
    updateActions();
    closeGallery();
  } catch {
    setGalleryNote("子作品の生成に失敗しました。", true);
  }
}

// --- 埋め込み未計算の作品をグラフ表示時に少しずつ解析する
let repairing = false;
async function repairEmbeddings() {
  if (repairing) return;
  const missing = gNodes.filter((n) => !Array.isArray(n.work.embedding)).slice(0, 5);
  if (!missing.length) return;
  repairing = true;
  let done = 0;
  for (const n of missing) {
    setGalleryNote(`画像を解析中… ${done + 1}/${missing.length}`);
    try {
      const res = await fetch(`/api/works/${n.id}/embed`, {
        method: "POST",
        headers: { "x-gallery-key": galleryKey() },
      });
      if (res.status === 503) {
        setGalleryNote("AI無料枠を使い切ったため、今回はレシピ類似のみで表示します。", true);
        break;
      }
      if (!res.ok) continue;
      const r = await res.json();
      n.work.embedding = r.embedding;
      n.work.caption = r.caption;
      done++;
    } catch {
      break;
    }
  }
  repairing = false;
  if (done) {
    computeEdges();
    setGalleryNote(`${done}件を解析してグラフを更新しました。`);
  }
}

// ---------------------------------------------------------------- 初期サンプル画像

// 乱数を固定シードで生成（サンプルの見た目を安定させる）
function srand(s) {
  return () => (s = (s * 16807 + 19487171) % 2147483647) / 2147483647;
}

function drawSunsetGrid(x, w, h) {
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
}

function drawNeonAlley(x, w, h) {
  const rnd = srand(7);
  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#07070f");
  g.addColorStop(0.6, "#141024");
  g.addColorStop(1, "#1c1230");
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);
  const horizon = h * 0.72;

  // 路地の突き当たりの明かり（奥行き）
  const dg = x.createRadialGradient(w * 0.5, horizon * 0.96, 10, w * 0.5, horizon * 0.96, w * 0.34);
  dg.addColorStop(0, "rgba(255,120,170,0.5)");
  dg.addColorStop(0.4, "rgba(150,80,180,0.22)");
  dg.addColorStop(1, "transparent");
  x.fillStyle = dg;
  x.fillRect(0, 0, w, h);
  // 遠景ビル
  for (let i = 0; i < 8; i++) {
    const bw = 40 + rnd() * 60;
    const bh = h * (0.1 + rnd() * 0.16);
    x.fillStyle = "rgba(22,18,38,0.9)";
    x.fillRect(w * 0.3 + rnd() * w * 0.4, horizon - bh, bw, bh);
  }

  // 両側のビルと窓明かり
  for (let side = 0; side < 2; side++) {
    let bx = side ? w : 0;
    for (let i = 0; i < 3; i++) {
      const bw = 80 + rnd() * 100;
      const bh = h * (0.5 + rnd() * 0.45);
      const px = side ? bx - bw : bx;
      x.fillStyle = i % 2 ? "#0b0b14" : "#0e0d18";
      x.fillRect(px, horizon - bh, bw, bh);
      for (let wy = horizon - bh + 18; wy < horizon - 14; wy += 30) {
        for (let wx = px + 12; wx < px + bw - 12; wx += 26) {
          if (rnd() < 0.3) {
            x.fillStyle = rnd() < 0.6 ? "rgba(255,209,102,0.7)" : "rgba(120,220,255,0.55)";
            x.fillRect(wx, wy, 9, 13);
          }
        }
      }
      bx = side ? px : px + bw;
    }
  }

  // ネオンサインと路面反射
  const signs = [
    { t: "ノイズ", c: "#ff3ea5", vx: w * 0.16, vy: h * 0.26 },
    { t: "実験室", c: "#35e0ff", vx: w * 0.79, vy: h * 0.2 },
    { t: "エモ", c: "#c8ff00", vx: w * 0.7, vy: h * 0.5 },
    { t: "BAR", c: "#ff8c42", vx: w * 0.24, vy: h * 0.54 },
  ];
  for (const s of signs) {
    x.save();
    x.font = "42px 'DotGothic16', monospace";
    x.textAlign = "center";
    x.shadowColor = s.c;
    x.shadowBlur = 26;
    x.fillStyle = s.c;
    x.fillText(s.t, s.vx, s.vy);
    x.globalAlpha = 0.55;
    x.strokeStyle = s.c;
    x.lineWidth = 2;
    x.strokeRect(s.vx - 64, s.vy - 42, 128, 58);
    x.restore();
  }
  for (const s of signs) {
    const rg = x.createLinearGradient(0, horizon, 0, h);
    rg.addColorStop(0, s.c + "55");
    rg.addColorStop(1, "transparent");
    x.fillStyle = rg;
    x.fillRect(s.vx - 30, horizon, 60, h - horizon);
  }
  x.fillStyle = "rgba(10,8,18,0.5)";
  x.fillRect(0, horizon, w, h - horizon);

  // 雨
  x.strokeStyle = "rgba(200,215,255,0.18)";
  x.lineWidth = 1;
  for (let i = 0; i < 170; i++) {
    const rx = rnd() * w, ry = rnd() * h, len = 14 + rnd() * 18;
    x.beginPath();
    x.moveTo(rx, ry);
    x.lineTo(rx - 3, ry + len);
    x.stroke();
  }
}

function drawMoonSea(x, w, h) {
  const rnd = srand(21);
  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#0a0d24");
  g.addColorStop(0.55, "#2a2150");
  g.addColorStop(0.72, "#684a78");
  g.addColorStop(1, "#141230");
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);
  const horizon = h * 0.66;

  for (let i = 0; i < 90; i++) {
    x.fillStyle = `rgba(255,255,255,${0.2 + rnd() * 0.6})`;
    x.fillRect(rnd() * w, rnd() * horizon * 0.85, 2, 2);
  }

  // 月とグロー
  const mx = w * 0.62, my = h * 0.3, mr = 90;
  const mg = x.createRadialGradient(mx, my, mr * 0.4, mx, my, mr * 3);
  mg.addColorStop(0, "rgba(255,240,214,0.9)");
  mg.addColorStop(0.2, "rgba(255,225,180,0.35)");
  mg.addColorStop(1, "transparent");
  x.fillStyle = mg;
  x.fillRect(0, 0, w, h);
  x.fillStyle = "#ffeecf";
  x.beginPath(); x.arc(mx, my, mr, 0, Math.PI * 2); x.fill();
  x.fillStyle = "rgba(214,190,160,0.4)";
  x.beginPath(); x.arc(mx - 26, my - 12, 16, 0, Math.PI * 2); x.fill();
  x.beginPath(); x.arc(mx + 18, my + 24, 11, 0, Math.PI * 2); x.fill();

  // 雲
  for (let i = 0; i < 5; i++) {
    const cy = h * (0.18 + rnd() * 0.35);
    x.fillStyle = "rgba(40,34,80,0.55)";
    x.beginPath();
    x.ellipse(rnd() * w, cy, 150 + rnd() * 260, 14 + rnd() * 10, 0, 0, Math.PI * 2);
    x.fill();
  }

  // 海と月の道
  x.fillStyle = "#10122c";
  x.fillRect(0, horizon, w, h - horizon);
  for (let i = 0; i < 90; i++) {
    x.fillStyle = `rgba(120,110,190,${0.05 + rnd() * 0.12})`;
    x.fillRect(rnd() * w, horizon + rnd() * (h - horizon), 20 + rnd() * 120, 2);
  }
  for (let i = 0; i < 46; i++) {
    const ly = horizon + (i / 46) * (h - horizon);
    const spread = 20 + i * 3.4;
    const lw = 12 + rnd() * spread;
    x.fillStyle = `rgba(255,224,170,${0.35 - i * 0.005})`;
    x.fillRect(mx - lw / 2 + (rnd() - 0.5) * spread * 0.7, ly, lw, 2.4);
  }
}

function drawDuskMountains(x, w, h) {
  const rnd = srand(5);
  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#2b1a4e");
  g.addColorStop(0.45, "#a4486a");
  g.addColorStop(0.7, "#ff9d5c");
  g.addColorStop(1, "#ffd9a0");
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);

  // 沈む太陽
  const sx = w * 0.46, sy = h * 0.6;
  const sg = x.createRadialGradient(sx, sy, 10, sx, sy, 320);
  sg.addColorStop(0, "rgba(255,236,200,0.95)");
  sg.addColorStop(0.25, "rgba(255,170,90,0.5)");
  sg.addColorStop(1, "transparent");
  x.fillStyle = sg;
  x.fillRect(0, 0, w, h);
  x.fillStyle = "#fff1cd";
  x.beginPath(); x.arc(sx, sy, 64, 0, Math.PI * 2); x.fill();

  // 山のシルエット4層
  const layers = [
    { base: 0.55, amp: 90, col: "#7a3f66" },
    { base: 0.66, amp: 110, col: "#54305c" },
    { base: 0.78, amp: 120, col: "#331f47" },
    { base: 0.88, amp: 90, col: "#1c1230" },
  ];
  layers.forEach((L, li) => {
    x.fillStyle = L.col;
    x.beginPath();
    x.moveTo(0, h);
    for (let px = 0; px <= w; px += 8) {
      const t = px / w;
      const yv = h * L.base -
        Math.abs(Math.sin(t * 4.4 + li * 2.1) + Math.sin(t * 9.7 + li)) * L.amp * 0.5 -
        Math.sin(t * 23 + li * 5) * 8;
      x.lineTo(px, yv);
    }
    x.lineTo(w, h);
    x.closePath();
    x.fill();
  });

  // 鳥
  x.strokeStyle = "rgba(30,16,40,0.85)";
  x.lineWidth = 2.4;
  for (let i = 0; i < 7; i++) {
    const bx = w * (0.2 + rnd() * 0.55), by = h * (0.16 + rnd() * 0.24), s = 7 + rnd() * 9;
    x.beginPath();
    x.moveTo(bx - s, by);
    x.quadraticCurveTo(bx - s * 0.4, by - s * 0.7, bx, by);
    x.quadraticCurveTo(bx + s * 0.4, by - s * 0.7, bx + s, by);
    x.stroke();
  }

  // 夕靄
  const mist = x.createLinearGradient(0, h * 0.5, 0, h);
  mist.addColorStop(0, "transparent");
  mist.addColorStop(1, "rgba(255,190,140,0.22)");
  x.fillStyle = mist;
  x.fillRect(0, 0, w, h);
}

const SAMPLES = [drawSunsetGrid, drawNeonAlley, drawMoonSea, drawDuskMountains];
let sampleIndex = 0;

function makeSample(i = 0) {
  sampleIndex = ((i % SAMPLES.length) + SAMPLES.length) % SAMPLES.length;
  const w = 1200, h = 800;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  SAMPLES[sampleIndex](c.getContext("2d"), w, h);
  setSourceImage(c, w, h);
  document.getElementById("drop-hint").style.display = "";
}
document.getElementById("btn-sample").addEventListener("click", () => makeSample(sampleIndex + 1));

// URLハッシュで初期状態を指定可（例: /#preset=CINEMA&sample=2）。指定なしはY2Kでデモ
const sampleMatch = location.hash.match(/sample=(\d+)/);
makeSample(sampleMatch ? +sampleMatch[1] : 0);
const presetMatch = location.hash.match(/preset=([A-Z0-9]+)/i);
const initialPreset =
  (presetMatch && PRESETS.find((p) => p.name === presetMatch[1].toUpperCase())) || PRESETS[1];
applyPreset(initialPreset);
// シーン仕様をハッシュ指定でも描画可（テスト・共有用。例: /#scene=<urlencoded JSON>）
const sceneHashMatch = location.hash.match(/scene=([^&]+)/);
if (sceneHashMatch && sceneHashMatch[1].length < 2048) {
  try {
    renderScene(JSON.parse(decodeURIComponent(sceneHashMatch[1])));
  } catch { /* 不正なハッシュは無視してサンプルのまま */ }
}
