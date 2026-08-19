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

const FRAG_TRANS = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform float u_t;     // 0=A → 1=B
uniform int u_mode;    // 0:fade 1:wipe 2:dissolve 3:glitch
uniform vec2 u_res;
uniform float u_seed2;
uniform float u_zoomA; // Ken Burnsズーム倍率（1で等倍）
uniform float u_zoomB;
float th(float n) { return fract(sin(n * 127.1 + u_seed2 * 311.7) * 43758.5453); }
float th2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + u_seed2 * 17.0) * 43758.5453); }
vec4 sA(vec2 p) { return texture(u_a, clamp(0.5 + (p - 0.5) / u_zoomA, 0.0, 1.0)); }
vec4 sB(vec2 p) { return texture(u_b, clamp(0.5 + (p - 0.5) / u_zoomB, 0.0, 1.0)); }
void main() {
  vec2 uv = v_uv;
  float t = clamp(u_t, 0.0, 1.0);
  vec4 A = sA(uv);
  vec4 B = sB(uv);
  if (u_mode == 0) {
    o = mix(A, B, smoothstep(0.0, 1.0, t));
  } else if (u_mode == 1) {
    float e = smoothstep(-0.06, 0.06, uv.x - (t * 1.12 - 0.06));
    o = mix(B, A, e);
  } else if (u_mode == 2) {
    float r = th2(floor(uv * u_res / 16.0));
    o = mix(A, B, step(r, t));
  } else {
    float band = floor(uv.y * 36.0);
    float jit = th(band + floor(t * 24.0)) - 0.5;
    float p = sin(t * 3.14159);
    float edge = t * 1.2 - 0.1 + jit * 0.18 * p;
    float d = abs(uv.x - edge);
    float amt = exp(-d * 14.0) * p;
    vec2 duv = clamp(uv + vec2(jit * amt * 0.35, 0.0), 0.0, 1.0);
    float m = step(duv.x, edge);
    o = mix(sA(duv), sB(duv), m);
    vec2 ruv = clamp(duv + vec2(amt * 0.03, 0.0), 0.0, 1.0);
    vec2 buv = clamp(duv - vec2(amt * 0.03, 0.0), 0.0, 1.0);
    o.r = mix(sA(ruv), sB(ruv), m).r;
    o.b = mix(sA(buv), sB(buv), m).b;
  }
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
uniform float u_track;  // VHSトラッキングノイズ 0..1
uniform float u_wobble; // 走査線ゆらぎ 0..1
uniform float u_noise;
uniform float u_vig;
uniform float u_temp;   // 色温度 -1..1
uniform float u_fade;   // 黒浮き 0..1
uniform float u_split;  // ティール&オレンジ 0..1
uniform float u_sat;    // 彩度 (1が等倍)
uniform float u_con;    // コントラスト (1が等倍)
uniform float u_leak;   // 光漏れ 0..1.5
uniform float u_gradeFirst; // 1でグレードをディザの前に適用
uniform sampler2D u_text; // 文字オーバーレイ
uniform float u_textOn;

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

vec3 applyGrade(vec3 c) {
  c *= vec3(1.0 + u_temp * 0.12, 1.0 + u_temp * 0.03, 1.0 - u_temp * 0.12);
  c = c * (1.0 - u_fade * 0.28) + vec3(u_fade * 0.10, u_fade * 0.095, u_fade * 0.105);
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  vec3 tone = mix(vec3(0.82, 1.02, 1.16), vec3(1.15, 1.0, 0.84), smoothstep(0.15, 0.85, l));
  c = mix(c, c * tone, u_split);
  l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, u_sat);
  return (c - 0.5) * u_con + 0.5;
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

  // VHSトラッキング（ゆっくり流れるノイズ帯で横ずれ）
  float trackM = 0.0;
  if (u_track > 0.0) {
    float bandPos = 1.0 - fract(u_time * 0.09);
    trackM = exp(-abs(uv.y - bandPos) * 45.0);
    puv.x += (hash(floor(puv.y * u_res.y) * 1.7 + floor(u_time * 24.0)) - 0.5) * trackM * u_track * 0.2;
  }
  // 走査線ゆらぎ（行ごとの横揺れ）
  if (u_wobble > 0.0) {
    puv.x += sin(puv.y * 7.0 + u_time * 2.2) * u_wobble * 0.006
           + sin(puv.y * 29.0 - u_time * 3.7) * u_wobble * 0.0035;
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

  // 適用順「ディザ前」のグレーディング
  if (u_gradeFirst > 0.5) col = applyGrade(col);

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
  } else if (u_dmode == 3) {
    // アスキーアート化（明度→9段階のグリフ、色は元画像由来）
    float cell2 = max(u_dscale, 1.0) * 8.0;
    vec2 cid = floor(gl_FragCoord.xy / cell2);
    vec2 cuv2 = clamp((cid + 0.5) * cell2 / u_res, 0.0, 1.0);
    vec3 sc2 = texture(u_base, cuv2).rgb;
    float lum3 = dot(sc2, vec3(0.299, 0.587, 0.114));
    int gi = int(clamp(lum3, 0.0, 0.999) * 9.0);
    int FONT[9] = int[9](0, 131072, 131200, 14336, 459200, 145536, 22511061, 11512810, 15728622);
    vec2 gp = fract(gl_FragCoord.xy / cell2);
    ivec2 gxy = ivec2(clamp(gp, vec2(0.0), vec2(0.999)) * 5.0);
    int bit = (FONT[gi] >> ((4 - gxy.y) * 5 + gxy.x)) & 1;
    vec3 ink = clamp(sc2 * 1.5 + 0.12, 0.0, 1.0);
    col = bit == 1 ? ink : vec3(0.015, 0.03, 0.02);
  }

  // カラーグレーディング（既定はディザ類の後段。「ディザ前」選択時は適用済み）
  if (u_gradeFirst < 0.5) col = applyGrade(col);

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

  // トラッキング帯のスノーノイズ
  if (trackM > 0.0) {
    col = mix(col, vec3(0.72 + 0.28 * hash2(uv * u_res + floor(u_time * 20.0))), trackM * u_track * 0.6);
  }

  // 文字入れ（グリッチ・ぼかしの影響を受けず、CRT湾曲・走査線・粒子には馴染む位置）
  if (u_textOn > 0.5) {
    vec4 tcol = texture(u_text, uv);
    col = mix(col, tcol.rgb, tcol.a * inside);
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
const transP = program(FRAG_TRANS);

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
const textTex = makeTex();
const clearTex = makeTex();
gl.bindTexture(gl.TEXTURE_2D, clearTex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));

let fboA = null, fboB = null, fboC = null, fboD = null, fboT = null;
let W = 0, H = 0;

function allocFbos(w, h) {
  for (const f of [fboA, fboB, fboC, fboD, fboT]) {
    if (f) { gl.deleteTexture(f.tex); gl.deleteFramebuffer(f.fbo); }
  }
  fboA = makeFbo(w, h); fboB = makeFbo(w, h);
  fboC = makeFbo(w, h); fboD = makeFbo(w, h);
  fboT = makeFbo(w, h);
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
  curve: 0.4, scan: 0.5, track: 0, wobble: 0,
  noise: 0.3, vig: 0.4,
  temp: 0.25, fade: 0.35, split: 0.5, sat: 1.1, con: 1.1, gorder: 0,
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
    seg: { key: "gorder", options: ["ディザ後", "ディザ前"] },
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
    seg: { key: "dmode", options: ["ベイヤー", "ハーフトーン", "アスキー"], offset: 1 },
    params: [
      { key: "dscale", label: "スケール", min: 1, max: 20, step: 1 },
      { key: "levels", label: "階調", min: 2, max: 8, step: 1 },
    ] },
  { id: "crt", name: "CRT / VHS", jp: "ブラウン管",
    params: [
      { key: "curve", label: "湾曲", min: 0, max: 1, step: 0.01 },
      { key: "scan", label: "走査線", min: 0, max: 1, step: 0.01 },
      { key: "track", label: "トラッキング", min: 0, max: 1, step: 0.01 },
      { key: "wobble", label: "ゆらぎ", min: 0, max: 1, step: 0.01 },
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
    set: { rgb: 4, curve: 0.5, scan: 0.65, track: 0.55, wobble: 0.35, noise: 0.35, vig: 0.5, blur: 1.5 } },
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

let originalData = null; // ImageData（処理解像度、重ね画像の合成後）
let baseData = null;     // 重ね画像を載せる前のベース画像

// ---- 重ね画像（ソース段階で合成し、エフェクトは合成後の全体にかかる）
const OVERLAY_BLENDS = ["source-over", "screen", "multiply", "lighter"];
const overlayState = { img: null, x: 0.7, y: 0.35, scale: 0.4, opacity: 1, blend: 0 };

function compositeSource() {
  if (!baseData) return;
  if (!overlayState.img) {
    originalData = baseData;
    uploadSource();
    return;
  }
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");
  ctx.putImageData(baseData, 0, 0);
  const ow = W * overlayState.scale;
  const oh = ow * (overlayState.img.height / overlayState.img.width);
  ctx.globalAlpha = overlayState.opacity;
  ctx.globalCompositeOperation = OVERLAY_BLENDS[overlayState.blend] || "source-over";
  ctx.drawImage(
    overlayState.img,
    W * overlayState.x - ow / 2,
    H * overlayState.y - oh / 2,
    ow,
    oh
  );
  originalData = ctx.getImageData(0, 0, W, H);
  uploadSource();
}

let compositePending = false;
function scheduleComposite() {
  if (compositePending) return;
  compositePending = true;
  requestAnimationFrame(() => {
    compositePending = false;
    compositeSource();
  });
}

const overlayInput = document.getElementById("overlay-input");
document.getElementById("overlay-open").addEventListener("click", () => overlayInput.click());
overlayInput.addEventListener("change", async () => {
  const f = overlayInput.files[0];
  overlayInput.value = "";
  if (!f) return;
  try {
    overlayState.img = await createImageBitmap(f);
    syncOverlayUI();
    compositeSource();
  } catch { /* 読み込めない画像は無視 */ }
});
document.getElementById("overlay-clear").addEventListener("click", () => {
  overlayState.img = null;
  syncOverlayUI();
  compositeSource();
});
for (const key of ["scale", "opacity"]) {
  const input = document.getElementById(`overlay-${key}`);
  input.addEventListener("input", () => {
    overlayState[key] = +input.value;
    document.getElementById(`overlay-${key}-val`).textContent = (+input.value).toFixed(2);
    scheduleComposite();
  });
}
document.getElementById("overlay-blend-seg").querySelectorAll("button").forEach((b, i) => {
  b.addEventListener("click", () => {
    overlayState.blend = i;
    document.getElementById("overlay-blend-seg").querySelectorAll("button")
      .forEach((v) => v.classList.remove("sel"));
    b.classList.add("sel");
    scheduleComposite();
  });
});

function syncOverlayUI() {
  document.getElementById("overlay-clear").disabled = !overlayState.img;
}

// 指定クライアント座標が重ね画像の矩形内か（ドラッグ対象の判定用）
function overlayHit(e) {
  if (!overlayState.img) return false;
  const r = canvas.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width;
  const py = (e.clientY - r.top) / r.height;
  const wN = overlayState.scale;
  const hN = wN * (overlayState.img.height / overlayState.img.width) * (W / H);
  return Math.abs(px - overlayState.x) <= wN / 2 && Math.abs(py - overlayState.y) <= hN / 2;
}

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
  baseData = ctx.getImageData(0, 0, W, H);
  // 新しいベース画像を読み込んだら重ね画像はリセット（二重焼き込み防止）
  overlayState.img = null;
  syncOverlayUI();
  canvas.width = W;
  canvas.height = H;
  allocFbos(W, H);
  compositeSource();
  updateTextTexture();
  uploadAllSlides(); // カット列は新しい解像度に合わせて再クロップ
  document.getElementById("status-res").textContent = `${W} × ${H} px`;
  document.getElementById("drop-hint").style.display = "none";
  requestAnimationFrame(updateCropGuide);
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

// ---------------------------------------------------------------- 文字入れ

const TEXT_DEFAULTS = { str: "", size: 0.12, x: 0.5, y: 0.82, color: 0, font: 0 };
const textState = { ...TEXT_DEFAULTS };
const TEXT_FONTS = [
  ["400", "'DotGothic16', monospace"],
  ["700", "'Zen Kaku Gothic New', sans-serif"],
  ["700", "'IBM Plex Mono', monospace"],
];
const TEXT_COLORS = ["#ffffff", "#0b0d0c", "#c8ff00", "#ff3ea5"];

// 文字入れ設定からW×Hのオーバーレイキャンバスを描く（エディタ用・カット用で共用）
function makeTextCanvas(ts, w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const x = c.getContext("2d");
  if (ts.str && ts.str.trim()) {
    const lines = ts.str.split("|").map((s) => s.trim()).filter(Boolean).slice(0, 3);
    const size = ts.size * w;
    const [weight, family] = TEXT_FONTS[ts.font] || TEXT_FONTS[0];
    x.font = `${weight} ${size}px ${family}`;
    x.textAlign = "center";
    x.textBaseline = "middle";
    const fill = TEXT_COLORS[ts.color] || "#ffffff";
    const outline = ts.color === 1 ? "rgba(255,255,255,0.9)" : "rgba(10,10,14,0.85)";
    const cx = w * ts.x;
    const cy = h * ts.y;
    const lh = size * 1.2;
    const y0 = cy - ((lines.length - 1) * lh) / 2;
    lines.forEach((ln, i) => {
      const y = y0 + i * lh;
      x.lineJoin = "round";
      x.lineWidth = size * 0.14;
      x.strokeStyle = outline;
      x.strokeText(ln, cx, y);
      x.shadowColor = fill;
      x.shadowBlur = size * 0.35;
      x.fillStyle = fill;
      x.fillText(ln, cx, y);
      x.shadowBlur = 0;
    });
  }
  return c;
}

function updateTextTexture() {
  if (!W || !H) return;
  const c = makeTextCanvas(textState, W, H);
  gl.bindTexture(gl.TEXTURE_2D, textTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  markDirty();
}

// Webフォント読み込み完了後に文字テクスチャを再生成（フォールバック焼き付き対策）
if (document.fonts?.ready) {
  document.fonts.ready.then(() => { if (textState.str.trim()) updateTextTexture(); });
}

const textInput = document.getElementById("text-input");
const textSizeInput = document.getElementById("text-size");
textInput.addEventListener("input", () => {
  textState.str = textInput.value;
  updateTextTexture();
  canvas.classList.toggle("text-drag", !!textState.str.trim());
});
textSizeInput.addEventListener("input", () => {
  textState.size = +textSizeInput.value;
  document.getElementById("text-size-val").textContent = textState.size.toFixed(3);
  updateTextTexture();
});
for (const axis of ["x", "y"]) {
  const input = document.getElementById(`text-${axis}`);
  input.addEventListener("input", () => {
    textState[axis] = +input.value;
    document.getElementById(`text-${axis}-val`).textContent = (+input.value).toFixed(2);
    updateTextTexture();
  });
}

// プレビュー上のドラッグで移動（重ね画像の上ならオーバーレイ、それ以外は文字）
let dragTarget = null; // "overlay" | "text" | null
let textTexPending = false;
canvas.addEventListener("pointerdown", (e) => {
  if (overlayHit(e)) dragTarget = "overlay";
  else if (textState.str.trim()) dragTarget = "text";
  else return;
  canvas.setPointerCapture(e.pointerId);
  e.preventDefault();
});
canvas.addEventListener("pointermove", (e) => {
  if (!dragTarget) return;
  const r = canvas.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width;
  const py = (e.clientY - r.top) / r.height;
  if (dragTarget === "overlay") {
    overlayState.x = Math.min(1.1, Math.max(-0.1, px));
    overlayState.y = Math.min(1.1, Math.max(-0.1, py));
    scheduleComposite();
    return;
  }
  textState.x = Math.min(0.95, Math.max(0.05, px));
  textState.y = Math.min(0.94, Math.max(0.06, py));
  syncTextUI();
  if (!textTexPending) {
    textTexPending = true;
    requestAnimationFrame(() => {
      textTexPending = false;
      updateTextTexture();
    });
  }
});
canvas.addEventListener("pointerup", () => { dragTarget = null; });

for (const [segId, key] of [
  ["text-font-seg", "font"],
  ["text-color-seg", "color"],
]) {
  const seg = document.getElementById(segId);
  seg.querySelectorAll("button").forEach((b, i) => {
    b.addEventListener("click", () => {
      textState[key] = i;
      seg.querySelectorAll("button").forEach((v) => v.classList.remove("sel"));
      b.classList.add("sel");
      updateTextTexture();
    });
  });
}

function applyTextRecipe(t) {
  const src = t && typeof t === "object" ? t : {};
  Object.assign(textState, TEXT_DEFAULTS, src);
  // 旧レシピ互換: pos(0/1/2) しかない場合は y に変換
  if (typeof src.y !== "number" && typeof src.pos === "number") {
    textState.y = [0.18, 0.5, 0.82][Math.min(2, Math.max(0, src.pos | 0))];
  }
  delete textState.pos;
  textState.x = Math.min(0.95, Math.max(0.05, +textState.x || 0.5));
  textState.y = Math.min(0.94, Math.max(0.06, +textState.y || 0.82));
  textState.color = Math.min(TEXT_COLORS.length - 1, Math.max(0, textState.color | 0));
  textState.font = Math.min(TEXT_FONTS.length - 1, Math.max(0, textState.font | 0));
  syncTextUI();
  updateTextTexture();
  canvas.classList.toggle("text-drag", !!textState.str.trim());
}

function syncTextUI() {
  textInput.value = textState.str;
  textSizeInput.value = textState.size;
  document.getElementById("text-size-val").textContent = (+textState.size).toFixed(3);
  for (const axis of ["x", "y"]) {
    document.getElementById(`text-${axis}`).value = textState[axis];
    document.getElementById(`text-${axis}-val`).textContent = (+textState[axis]).toFixed(2);
  }
  for (const [segId, key] of [
    ["text-font-seg", "font"],
    ["text-color-seg", "color"],
  ]) {
    document.getElementById(segId).querySelectorAll("button")
      .forEach((b, i) => b.classList.toggle("sel", i === textState[key]));
  }
}

// ---------------------------------------------------------------- 書き出し・シェア

let exportRatio = 0; // 0=元比率
const ratioSeg = document.getElementById("ratio-seg");
ratioSeg.querySelectorAll("button").forEach((b) => {
  b.addEventListener("click", () => {
    exportRatio = +b.dataset.r;
    ratioSeg.querySelectorAll("button").forEach((v) => v.classList.remove("sel"));
    b.classList.add("sel");
    updateCropGuide();
  });
});

function updateCropGuide() {
  const guide = document.getElementById("crop-guide");
  if (!exportRatio || !originalData) {
    guide.hidden = true;
    return;
  }
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (!cw || !ch) { guide.hidden = true; return; }
  const imgR = cw / ch;
  let gw, gh;
  if (exportRatio > imgR) { gw = cw; gh = cw / exportRatio; }
  else { gh = ch; gw = ch * exportRatio; }
  guide.hidden = false;
  guide.style.left = canvas.offsetLeft + (cw - gw) / 2 + "px";
  guide.style.top = canvas.offsetTop + (ch - gh) / 2 + "px";
  guide.style.width = gw + "px";
  guide.style.height = gh + "px";
}
window.addEventListener("resize", updateCropGuide);

document.getElementById("btn-save").addEventListener("click", () => {
  if (!originalData) return;
  render(animate ? performance.now() / 1000 : frozenTime);
  let sx = 0, sy = 0, sw = canvas.width, sh = canvas.height;
  if (exportRatio) {
    const imgR = sw / sh;
    if (exportRatio > imgR) {
      sh = Math.round(sw / exportRatio);
      sy = (canvas.height - sh) >> 1;
    } else {
      sw = Math.round(sh * exportRatio);
      sx = (canvas.width - sw) >> 1;
    }
  }
  const out = document.createElement("canvas");
  out.width = sw;
  out.height = sh;
  out.getContext("2d").drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  out.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `noizlab_${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, "image/png");
});

// ---------------------------------------------------------------- ショート動画（カット列＋トランジション）

const MAX_SLIDES = 8;
const slides = []; // {bmp, tex, thumb, recipe, override, textTex}
const seqState = { mode: 3, hold: 1.0, trans: 0.6, zoom: true, percut: true };
let seqPlaying = null; // {start, hold, trans, blit, onend}
let seqFrame = null;   // 再生中のフレーム情報 {texA, texB, t, zoomA, zoomB}
let seqOverride = null; // 再生中カットのエフェクト設定（nullなら編集中の設定を使用）

// カット追加時のレシピからrender用オーバーライドを構築する
function buildSlideOverride(s) {
  if (!s.recipe) { s.override = null; return; }
  const r = s.recipe;
  const en = {};
  for (const k of Object.keys(enabled)) en[k] = !!r.enabled?.[k];
  en.sort = false; // ピクセルソートはカット画像に焼き込み済み
  let textTexS = null;
  let textOn = false;
  if (r.text && typeof r.text.str === "string" && r.text.str.trim() && W && H) {
    textOn = true;
    if (!s.textTex) s.textTex = makeTex();
    const c = makeTextCanvas({ ...TEXT_DEFAULTS, ...r.text }, W, H);
    gl.bindTexture(gl.TEXTURE_2D, s.textTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }
  s.override = {
    enabled: en,
    state: { ...DEFAULTS, ...(r.state || {}) },
    seed: typeof r.seed === "number" ? r.seed : 1,
    textTex: textTexS = textOn ? s.textTex : null,
    textOn,
  };
}

// 再生位置に応じて使うカット設定（遷移の中間で切り替える）
function overrideFor(aIdx, bIdx, t) {
  if (!seqState.percut) return null;
  const s = t < 0.5 ? slides[aIdx] : slides[bIdx];
  return s?.override ?? null;
}
const transBtn = document.getElementById("btn-transition");
const transNote = document.getElementById("trans-note");
const slideStrip = document.getElementById("slide-strip");

// 経過時間から「どのカット同士を、どの遷移位置・ズームで描くか」を純粋計算する
function seqAt(elapsed, n, holdMs, transMs, zoomOn) {
  const per = holdMs + transMs;
  const i = Math.min(n - 1, Math.floor(elapsed / per));
  let t = 0;
  const inSeg = elapsed - i * per;
  if (i < n - 1 && inSeg > holdMs) t = Math.min(1, (inSeg - holdMs) / transMs);
  const zprog = (k) =>
    Math.min(1, Math.max(0, (elapsed - k * per + transMs) / (holdMs + 2 * transMs)));
  const zf = (k) =>
    !zoomOn ? 1 : k % 2 === 0 ? 1 + 0.08 * zprog(k) : 1.08 - 0.08 * zprog(k);
  const j = Math.min(n - 1, i + 1);
  return { a: i, b: j, t, zoomA: zf(i), zoomB: zf(j) };
}

function uploadSlide(s) {
  if (!s.bmp || !W || !H) return;
  // 編集画像の解像度にカバークロップして揃える
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");
  const sc = Math.max(W / s.bmp.width, H / s.bmp.height);
  const dw = s.bmp.width * sc;
  const dh = s.bmp.height * sc;
  ctx.drawImage(s.bmp, (W - dw) / 2, (H - dh) / 2, dw, dh);
  gl.bindTexture(gl.TEXTURE_2D, s.tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
}

function uploadAllSlides() {
  for (const s of slides) {
    uploadSlide(s);
    buildSlideOverride(s); // 文字テクスチャは解像度依存のため作り直す
  }
}

function seqTotalSec() {
  return slides.length * seqState.hold + Math.max(0, slides.length - 1) * seqState.trans;
}

function updateSeqNote() {
  transBtn.disabled = slides.length < 1 || !!seqPlaying;
  const gb = document.getElementById("btn-gif");
  if (gb) gb.disabled = slides.length < 1 || !!seqPlaying;
  transNote.textContent = slides.length
    ? `${slides.length}カット / 約${seqTotalSec().toFixed(1)}秒の動画になります。`
    : "「＋ 今の画像」でカットを並べてください。";
}

function renderSlideStrip() {
  slideStrip.innerHTML = "";
  slides.forEach((s, i) => {
    const d = document.createElement("div");
    d.className = "slide-item";
    d.draggable = true;
    d.innerHTML =
      `<img src="${s.thumb}" alt="カット${i + 1}" />` +
      `<button class="work-del" title="削除">✕</button><span class="slide-num">${i + 1}</span>`;
    d.querySelector("button").addEventListener("click", () => {
      gl.deleteTexture(slides[i].tex);
      if (slides[i].textTex) gl.deleteTexture(slides[i].textTex);
      slides.splice(i, 1);
      renderSlideStrip();
    });
    // ドラッグでカットの並び替え
    d.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", String(i));
      e.dataTransfer.effectAllowed = "move";
    });
    d.addEventListener("dragover", (e) => e.preventDefault());
    d.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = parseInt(e.dataTransfer.getData("text/plain"), 10);
      if (isNaN(from) || from === i) return;
      const [moved] = slides.splice(from, 1);
      slides.splice(i, 0, moved);
      renderSlideStrip();
    });
    slideStrip.appendChild(d);
  });
  updateSeqNote();
}

async function addSlideBitmap(bmp, recipe = null) {
  if (slides.length >= MAX_SLIDES) {
    transNote.textContent = `カットは最大${MAX_SLIDES}枚までです。`;
    return;
  }
  const s = { bmp, tex: makeTex(), thumb: null, recipe, override: null, textTex: null };
  uploadSlide(s);
  buildSlideOverride(s);
  const tc = document.createElement("canvas");
  tc.width = 96;
  tc.height = 64;
  const g2 = tc.getContext("2d");
  const sc = Math.max(96 / bmp.width, 64 / bmp.height);
  g2.drawImage(bmp, (96 - bmp.width * sc) / 2, (64 - bmp.height * sc) / 2, bmp.width * sc, bmp.height * sc);
  s.thumb = tc.toDataURL();
  slides.push(s);
  renderSlideStrip();
}

document.getElementById("slide-add").addEventListener("click", async () => {
  if (!originalData) return;
  // カットごとの設定用に、いまのラック設定+文字をレシピとして記録する。
  // ピクセルソートは画像に焼き込んでフラグを落とす（動画中は再計算できないため）
  const rec = currentRecipe();
  let data = originalData;
  if (enabled.sort) {
    const lo = Math.min(state.sortLow, state.sortHigh);
    const hi = Math.max(state.sortLow, state.sortHigh);
    data = pixelSorted(originalData, lo, hi, state.sortVert === 1);
  }
  addSlideBitmap(await createImageBitmap(data), rec);
});
const transbInput = document.getElementById("transb-input");
document.getElementById("slide-add-file").addEventListener("click", () => transbInput.click());
transbInput.addEventListener("change", async () => {
  const f = transbInput.files[0];
  transbInput.value = "";
  if (!f) return;
  try {
    addSlideBitmap(await createImageBitmap(f));
  } catch {
    transNote.textContent = "画像を読み込めませんでした。";
  }
});

document.getElementById("trans-mode-seg").querySelectorAll("button").forEach((b, i) => {
  b.addEventListener("click", () => {
    seqState.mode = i;
    document.getElementById("trans-mode-seg").querySelectorAll("button")
      .forEach((v) => v.classList.remove("sel"));
    b.classList.add("sel");
  });
});
document.getElementById("slide-hold").addEventListener("input", (e) => {
  seqState.hold = +e.target.value;
  document.getElementById("slide-hold-val").textContent = `${seqState.hold.toFixed(2)}s`;
  updateSeqNote();
});
document.getElementById("trans-duration").addEventListener("input", (e) => {
  seqState.trans = +e.target.value;
  document.getElementById("trans-duration-val").textContent = `${seqState.trans.toFixed(1)}s`;
  updateSeqNote();
});
document.getElementById("chk-zoom").addEventListener("change", (e) => {
  seqState.zoom = e.target.checked;
});
document.getElementById("chk-percut").addEventListener("change", (e) => {
  seqState.percut = e.target.checked;
});

// ---- プレビュータブ（編集=静止画 / プレビュー=カット列をループ再生）
let previewMode = false;
let previewStart = 0;
const tabEdit = document.getElementById("tab-edit");
const tabPreview = document.getElementById("tab-preview");

function setPreviewMode(on) {
  if (on && !slides.length) {
    transNote.textContent = "プレビューにはカットを1枚以上追加してください。";
    return;
  }
  previewMode = on;
  previewStart = performance.now();
  tabEdit.classList.toggle("sel", !on);
  tabPreview.classList.toggle("sel", on);
  if (!on) { seqFrame = null; seqOverride = null; }
  markDirty();
}
tabEdit.addEventListener("click", () => setPreviewMode(false));
tabPreview.addEventListener("click", () => setPreviewMode(true));

// ---- BPM同期（カット間隔 = 拍数 × 60/BPM になるよう表示時間を設定）
let bpmBeats = 2;
document.getElementById("bpm-beats").querySelectorAll("button").forEach((b, i) => {
  b.addEventListener("click", () => {
    bpmBeats = [1, 2, 4][i];
    document.getElementById("bpm-beats").querySelectorAll("button")
      .forEach((v) => v.classList.remove("sel"));
    b.classList.add("sel");
  });
});
document.getElementById("bpm-apply").addEventListener("click", () => {
  const bpm = Math.min(220, Math.max(40, +document.getElementById("bpm-input").value || 120));
  const interval = (60 / bpm) * bpmBeats;
  let msg = "";
  if (interval - seqState.trans < 0.1) {
    seqState.trans = Math.max(0.2, Math.round((interval / 2) * 10) / 10);
    document.getElementById("trans-duration").value = seqState.trans;
    document.getElementById("trans-duration-val").textContent = `${seqState.trans.toFixed(1)}s`;
    msg = "／切替が長すぎたため短縮しました";
  }
  seqState.hold = Math.min(3, Math.max(0.1, interval - seqState.trans));
  document.getElementById("slide-hold").value = seqState.hold;
  document.getElementById("slide-hold-val").textContent = `${seqState.hold.toFixed(2)}s`;
  transNote.textContent =
    `♪ ${bpm}BPM × ${bpmBeats}拍 = ${interval.toFixed(2)}s間隔` +
    `（表示${seqState.hold.toFixed(2)}s + 切替${seqState.trans.toFixed(1)}s）${msg}`;
});

// ---- BPM自動検出（エネルギーフラックスの自己相関。適用は手動のまま）
function detectBPM(buffer) {
  const sr = buffer.sampleRate;
  const data = buffer.getChannelData(0);
  const hop = 512;
  const n = Math.floor(data.length / hop);
  if (n < 64) return 0;
  const energy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const off = i * hop;
    for (let j = 0; j < hop; j++) s += data[off + j] * data[off + j];
    energy[i] = s;
  }
  const flux = new Float32Array(n);
  for (let i = 1; i < n; i++) flux[i] = Math.max(0, energy[i] - energy[i - 1]);
  const fps = sr / hop;
  const score = (bpm) => {
    const lag = (fps * 60) / bpm;
    const l0 = Math.floor(lag);
    const fr = lag - l0;
    let s = 0, c = 0;
    for (let i = 0; i + l0 + 1 < n; i++) {
      s += flux[i] * (flux[i + l0] * (1 - fr) + flux[i + l0 + 1] * fr);
      c++;
    }
    return c ? s / c : 0;
  };
  let bestBpm = 0;
  let best = 0;
  for (let bpm = 60; bpm <= 200; bpm += 0.5) {
    const s = score(bpm);
    if (s > best) { best = s; bestBpm = bpm; }
  }
  // 半分/2倍テンポの曖昧さは80-160のレンジを優先して解決する
  if (bestBpm && (bestBpm < 80 || bestBpm > 160)) {
    for (const cand of [bestBpm / 2, bestBpm * 2]) {
      if (cand >= 80 && cand <= 160 && score(cand) > best * 0.9) {
        bestBpm = cand;
        break;
      }
    }
  }
  return Math.round(bestBpm);
}

// ---- BGM（録画時に音声トラックとして合成）
let bgmBuffer = null;
const bgmInput = document.getElementById("bgm-input");
const bgmNameEl = document.getElementById("bgm-name");
document.getElementById("bgm-open").addEventListener("click", () => bgmInput.click());
bgmInput.addEventListener("change", async () => {
  const f = bgmInput.files[0];
  bgmInput.value = "";
  if (!f) return;
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    bgmBuffer = await ac.decodeAudioData(await f.arrayBuffer());
    ac.close();
    const bpm = detectBPM(bgmBuffer);
    bgmNameEl.hidden = false;
    bgmNameEl.textContent =
      `♫ ${f.name}（${bgmBuffer.duration.toFixed(1)}s${bpm ? ` / 推定${bpm}BPM` : ""}）`;
    if (bpm) document.getElementById("bpm-input").value = bpm;
    document.getElementById("bgm-clear").disabled = false;
  } catch {
    transNote.textContent = "BGMを読み込めませんでした（mp3/wav/m4a等）。";
  }
});
document.getElementById("bgm-clear").addEventListener("click", () => {
  bgmBuffer = null;
  bgmNameEl.hidden = true;
  bgmNameEl.textContent = "";
  document.getElementById("bgm-clear").disabled = true;
});

async function exportSequence() {
  if (slides.length < 1 || seqPlaying || !originalData) return;
  setPreviewMode(false); // 録画が優先。終了後は編集タブに戻る
  transBtn.disabled = true;
  transBtn.textContent = "録画中…";
  let audioCtx = null;
  let audioSrc = null;
  try {
    // 書き出し比率で中央クロップし、長辺1280・偶数サイズ(H.264要件)へスケール
    let sx = 0, sy = 0, sw = canvas.width, sh = canvas.height;
    if (exportRatio) {
      const imgR = sw / sh;
      if (exportRatio > imgR) {
        sh = Math.round(sw / exportRatio);
        sy = (canvas.height - sh) >> 1;
      } else {
        sw = Math.round(sh * exportRatio);
        sx = (canvas.width - sw) >> 1;
      }
    }
    const scaleOut = 1280 / Math.max(sw, sh);
    const ow = Math.round((sw * scaleOut) / 2) * 2;
    const oh = Math.round((sh * scaleOut) / 2) * 2;
    const crop = document.createElement("canvas");
    crop.width = ow;
    crop.height = oh;
    const cctx = crop.getContext("2d");

    const stream = crop.captureStream(30);
    // BGMがあれば音声トラックを合成する
    let recStream = stream;
    if (bgmBuffer) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      await audioCtx.resume();
      audioSrc = audioCtx.createBufferSource();
      audioSrc.buffer = bgmBuffer;
      const dest = audioCtx.createMediaStreamDestination();
      audioSrc.connect(dest);
      recStream = new MediaStream([
        ...stream.getVideoTracks(),
        ...dest.stream.getAudioTracks(),
      ]);
    }
    // リール等でそのまま使えるMP4(H.264)を最優先、非対応環境はWebMへ
    const mimeList = bgmBuffer
      ? ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"]
      : ["video/mp4;codecs=avc1.42E01E", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    const mime = mimeList.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
    if (!mime) throw new Error("MediaRecorder unsupported");
    const rec = new MediaRecorder(recStream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise((res) => (rec.onstop = res));
    rec.start(200);

    seqPlaying = {
      start: performance.now(),
      hold: seqState.hold * 1000,
      trans: seqState.trans * 1000,
      blit: () => cctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, ow, oh),
    };
    if (audioSrc) audioSrc.start();
    markDirty();
    // ウィンドウが隠れるとrAFが止まり進行しないため、タイムアウトで中断する
    const totalMs = seqTotalSec() * 1000 + 400;
    const finished = await Promise.race([
      new Promise((res) => (seqPlaying.onend = () => res(true))),
      new Promise((res) => setTimeout(() => res(false), totalMs + 5000)),
    ]);
    rec.stop();
    await stopped;
    if (!finished) {
      transNote.textContent = "書き出しがタイムアウトしました。録画中はこのウィンドウを前面に表示したままにしてください。";
      return;
    }
    const isMp4 = (rec.mimeType || mime).includes("mp4");
    const blob = new Blob(chunks, { type: mime.split(";")[0] });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `noizlab_video_${Date.now()}.${isMp4 ? "mp4" : "webm"}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    const bgmTag = bgmBuffer ? "♫BGM入り" : "";
    transNote.textContent = isMp4
      ? `MP4で保存しました（${ow}×${oh}${bgmTag}）。そのままリール/ショートに使えます。`
      : `WebMで保存しました（${ow}×${oh}${bgmTag}）。投稿先によってはMP4変換が必要です。`;
  } catch {
    transNote.textContent = "動画の書き出しに失敗しました（Safariでは非対応の場合があります）。";
  } finally {
    try { audioSrc?.stop(); } catch { /* 既に終了済みなら無視 */ }
    try { audioCtx?.close(); } catch { /* noop */ }
    seqPlaying = null;
    seqFrame = null;
    seqOverride = null;
    markDirty();
    transBtn.textContent = "▶ 動画書き出し";
    // 結果メッセージを残すため、ここではボタン状態のみ戻す
    transBtn.disabled = slides.length < 1;
  }
}
transBtn.addEventListener("click", exportSequence);

// ---- GIF書き出し（オフライン描画 + 自前GIF89aエンコーダ）
// リアルタイム録画不要なのでウィンドウが隠れていても書き出せる

function medianCutPalette(frames, maxColors) {
  const samples = [];
  const totalPx = frames.length * (frames[0].data.length / 4);
  const step = Math.max(1, Math.floor(totalPx / 40000));
  for (const fr of frames) {
    const d = fr.data;
    for (let p = 0; p < d.length; p += 4 * step) {
      samples.push([d[p], d[p + 1], d[p + 2]]);
    }
  }
  let boxes = [samples];
  while (boxes.length < maxColors) {
    boxes.sort((a, b) => b.length - a.length);
    const box = boxes[0];
    if (box.length < 2) break;
    boxes.shift();
    const mins = [255, 255, 255];
    const maxs = [0, 0, 0];
    for (const c of box) {
      for (let k = 0; k < 3; k++) {
        if (c[k] < mins[k]) mins[k] = c[k];
        if (c[k] > maxs[k]) maxs[k] = c[k];
      }
    }
    const ranges = [maxs[0] - mins[0], maxs[1] - mins[1], maxs[2] - mins[2]];
    const axis = ranges.indexOf(Math.max(...ranges));
    box.sort((a, b) => a[axis] - b[axis]);
    const mid = box.length >> 1;
    boxes.push(box.slice(0, mid), box.slice(mid));
  }
  return boxes.map((box) => {
    let r = 0, g = 0, b = 0;
    for (const c of box) { r += c[0]; g += c[1]; b += c[2]; }
    const n = box.length || 1;
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  });
}

function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let dict = new Map();
  let nextCode = eoiCode + 1;
  const bytes = [];
  let cur = 0, curBits = 0;
  const push = (code) => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) { bytes.push(cur & 0xff); cur >>>= 8; curBits -= 8; }
  };
  push(clearCode);
  let buffer = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const c = indices[i];
    const key = buffer * 256 + c;
    if (dict.has(key)) {
      buffer = dict.get(key);
      continue;
    }
    push(buffer);
    if (nextCode === 4096) {
      push(clearCode);
      dict = new Map();
      nextCode = eoiCode + 1;
      codeSize = minCodeSize + 1;
    } else {
      dict.set(key, nextCode);
      nextCode++;
      if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
    }
    buffer = c;
  }
  push(buffer);
  push(eoiCode);
  if (curBits > 0) bytes.push(cur & 0xff);
  return bytes;
}

function encodeGif(frames, w, h, delayCs) {
  const palette = medianCutPalette(frames, 256);
  while (palette.length < 256) palette.push([0, 0, 0]);
  // 量子化キー(5bit/ch)→最近傍indexのキャッシュ
  const cache = new Int16Array(32768).fill(-1);
  const nearest = (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let idx = cache[key];
    if (idx >= 0) return idx;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      const d = (r - p[0]) ** 2 + (g - p[1]) ** 2 + (b - p[2]) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    cache[key] = best;
    return best;
  };
  const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

  const out = [];
  const u16 = (v) => { out.push(v & 0xff, (v >> 8) & 0xff); };
  // ヘッダ + 論理スクリーン記述子 + グローバルカラーテーブル
  for (const ch of "GIF89a") out.push(ch.charCodeAt(0));
  u16(w); u16(h);
  out.push(0xf7, 0, 0);
  for (const p of palette) out.push(p[0], p[1], p[2]);
  // ループ用 NETSCAPE 拡張
  out.push(0x21, 0xff, 0x0b);
  for (const ch of "NETSCAPE2.0") out.push(ch.charCodeAt(0));
  out.push(0x03, 0x01, 0x00, 0x00, 0x00);

  for (const fr of frames) {
    const d = fr.data;
    const indices = new Uint8Array(d.length / 4);
    for (let p = 0, i = 0; p < d.length; p += 4, i++) {
      // 軽いベイヤーディザでバンディングを抑える
      const x = i % w, y = (i / w) | 0;
      const dth = (BAYER4[(y & 3) * 4 + (x & 3)] - 7.5) * 1.4;
      const r = Math.max(0, Math.min(255, d[p] + dth));
      const g = Math.max(0, Math.min(255, d[p + 1] + dth));
      const b = Math.max(0, Math.min(255, d[p + 2] + dth));
      indices[i] = nearest(r | 0, g | 0, b | 0);
    }
    // グラフィック制御拡張（遅延）+ 画像記述子
    out.push(0x21, 0xf9, 0x04, 0x04);
    u16(delayCs);
    out.push(0x00, 0x00);
    out.push(0x2c);
    u16(0); u16(0); u16(w); u16(h);
    out.push(0x00);
    out.push(8); // LZW最小コードサイズ
    const lzw = lzwEncode(indices, 8);
    for (let i = 0; i < lzw.length; i += 255) {
      const chunk = lzw.slice(i, i + 255);
      out.push(chunk.length, ...chunk);
    }
    out.push(0x00);
  }
  out.push(0x3b);
  return new Uint8Array(out);
}

const gifBtn = document.getElementById("btn-gif");
async function exportGif() {
  if (slides.length < 1 || seqPlaying || !originalData) return;
  setPreviewMode(false);
  gifBtn.disabled = true;
  transBtn.disabled = true;
  try {
    const fps = 15;
    const n = slides.length;
    const holdMs = seqState.hold * 1000;
    const transMs = seqState.trans * 1000;
    const total = n * holdMs + (n - 1) * transMs;
    const count = Math.min(240, Math.max(2, Math.round((total / 1000) * fps)));

    let sx = 0, sy = 0, sw = canvas.width, sh = canvas.height;
    if (exportRatio) {
      const imgR = sw / sh;
      if (exportRatio > imgR) { sh = Math.round(sw / exportRatio); sy = (canvas.height - sh) >> 1; }
      else { sw = Math.round(sh * exportRatio); sx = (canvas.width - sw) >> 1; }
    }
    const scale = Math.min(1, 480 / Math.max(sw, sh));
    const ow = Math.max(2, Math.round((sw * scale) / 2) * 2);
    const oh = Math.max(2, Math.round((sh * scale) / 2) * 2);
    const oc = document.createElement("canvas");
    oc.width = ow; oc.height = oh;
    const octx = oc.getContext("2d", { willReadFrequently: true });

    const frames = [];
    for (let f = 0; f < count; f++) {
      const tMs = (f / fps) * 1000;
      const s = seqAt(Math.min(tMs, total), n, holdMs, transMs, seqState.zoom);
      seqFrame = {
        texA: slides[s.a].tex, texB: slides[s.b].tex,
        t: s.t, zoomA: s.zoomA, zoomB: s.zoomB,
      };
      seqOverride = overrideFor(s.a, s.b, s.t);
      render(tMs / 1000); // 仮想時刻。ウィンドウが隠れていても進む
      octx.drawImage(canvas, sx, sy, sw, sh, 0, 0, ow, oh);
      frames.push(octx.getImageData(0, 0, ow, oh));
      if (f % 6 === 5) {
        gifBtn.textContent = `描画中 ${f + 1}/${count}`;
        await new Promise((r) => setTimeout(r));
      }
    }
    seqFrame = null;
    seqOverride = null;
    markDirty();

    gifBtn.textContent = "エンコード中…";
    await new Promise((r) => setTimeout(r));
    const gif = encodeGif(frames, ow, oh, Math.round(100 / fps));

    const blob = new Blob([gif], { type: "image/gif" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `noizlab_${Date.now()}.gif`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    transNote.textContent = `GIFで保存しました（${ow}×${oh} / ${count}コマ / ${(blob.size / 1024 / 1024).toFixed(1)}MB）。Xにそのまま投稿できます。`;
  } catch (e) {
    transNote.textContent = "GIFの書き出しに失敗しました。";
  } finally {
    seqFrame = null;
    seqOverride = null;
    markDirty();
    gifBtn.textContent = "◉ GIF書き出し";
    gifBtn.disabled = slides.length < 1;
    transBtn.disabled = slides.length < 1;
  }
}
gifBtn.addEventListener("click", exportGif);

// ---- レシピURL共有（現在の設定をURLハッシュにシリアライズ）
const b64urlEncode = (str) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(str)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlDecode = (b64) => {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

function buildRecipeUrl() {
  const r3 = (v) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v);
  const s = {};
  for (const [k, v] of Object.entries(state)) s[k] = r3(v);
  const payload = { v: 1, e: { ...enabled }, s, seed: r3(seed), t: { ...textState } };
  return `${location.origin}/#r=${b64urlEncode(JSON.stringify(payload))}`;
}

function applyRecipeObject(r) {
  Object.assign(state, DEFAULTS, r?.s && typeof r.s === "object" ? r.s : {});
  for (const k of Object.keys(enabled)) enabled[k] = !!r?.e?.[k];
  seed = typeof r?.seed === "number" ? r.seed : 1;
  syncUI();
  applyTextRecipe(r?.t);
  scheduleSort();
  markDirty();
}

document.getElementById("btn-recipe-url").addEventListener("click", async () => {
  const b = document.getElementById("btn-recipe-url");
  try {
    await navigator.clipboard.writeText(buildRecipeUrl());
    b.textContent = "コピーしました ✓";
  } catch {
    b.textContent = "コピー失敗";
  }
  setTimeout(() => { b.textContent = "🔗 レシピURL"; }, 1800);
});

document.getElementById("btn-share").addEventListener("click", () => {
  const text = "NOIZ LAB で画像にエフェクトをかけた🎛️";
  window.open(
    `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(buildRecipeUrl())}&hashtags=NOIZLAB`,
    "_blank",
    "noopener"
  );
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

// LLMが設計したシーン仕様(JSON)をエディタに読み込む
function renderScene(specIn) {
  pendingParents = null;
  const w = 1200, h = 800;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  drawSceneSpec(c.getContext("2d"), w, h, specIn);
  setSourceImage(c, w, h);
  document.getElementById("drop-hint").style.display = "";
}

// シーン仕様をCanvasでベクター風に描画する。
// 仕様は信用せず、全フィールドをクランプ・検証して不正値でも必ず描き切る。
function drawSceneSpec(x, w, h, specIn) {
  const spec = specIn && typeof specIn === "object" ? specIn : {};
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

  // カットごとの設定が有効な再生中は、そのカットのレシピで描画する
  const ov = seqOverride;
  const en = ov ? ov.enabled : enabled;
  const st = ov ? ov.state : state;
  const sd = ov ? ov.seed : seed;

  let base = srcTex;

  // シーケンス再生中はカット同士を合成したものをソースとして流す
  if (seqFrame) {
    gl.useProgram(transP.prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboT.fbo);
    gl.viewport(0, 0, W, H);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, seqFrame.texA);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, seqFrame.texB);
    const tu = transP.u;
    gl.uniform1i(tu.u_a, 0);
    gl.uniform1i(tu.u_b, 1);
    gl.uniform1f(tu.u_t, seqFrame.t);
    gl.uniform1i(tu.u_mode, seqState.mode);
    gl.uniform2f(tu.u_res, W, H);
    gl.uniform1f(tu.u_seed2, sd);
    gl.uniform1f(tu.u_zoomA, seqFrame.zoomA);
    gl.uniform1f(tu.u_zoomB, seqFrame.zoomB);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    base = fboT.tex;
  }
  const blurR = en.blur ? st.blur : 0;
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
  const hal = en.halation ? st.halation : 0;
  if (hal > 0.01) {
    const glowR = Math.min(40, Math.max(8, W * 0.012));
    pass(brightP, base, fboC, (u) => { gl.uniform1f(u.u_thresh, st.halThresh); });
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
  gl.uniform1f(u.u_seed, sd);
  gl.uniform1f(u.u_glitch, en.glitch ? st.glitch : 0);
  gl.uniform1f(u.u_rgb, en.rgb ? st.rgb : 0);
  gl.uniform1f(u.u_halation, hal);
  gl.uniform1f(u.u_pixel, en.pixel ? st.pixel : 0);
  gl.uniform1i(u.u_dmode, en.dither ? st.dmode : 0);
  gl.uniform1f(u.u_dscale, st.dscale);
  gl.uniform1f(u.u_levels, st.levels);
  gl.uniform1f(u.u_curve, en.crt ? st.curve : 0);
  gl.uniform1f(u.u_scan, en.crt ? st.scan : 0);
  gl.uniform1f(u.u_track, en.crt ? st.track : 0);
  gl.uniform1f(u.u_wobble, en.crt ? st.wobble : 0);
  gl.uniform1f(u.u_noise, en.grain ? st.noise : 0);
  gl.uniform1f(u.u_vig, en.grain ? st.vig : 0);
  gl.uniform1f(u.u_temp, en.grade ? st.temp : 0);
  gl.uniform1f(u.u_fade, en.grade ? st.fade : 0);
  gl.uniform1f(u.u_split, en.grade ? st.split : 0);
  gl.uniform1f(u.u_sat, en.grade ? st.sat : 1);
  gl.uniform1f(u.u_con, en.grade ? st.con : 1);
  gl.uniform1f(u.u_leak, en.leak ? st.leak : 0);
  gl.uniform1f(u.u_gradeFirst, st.gorder ? 1 : 0);
  const textOn = ov ? ov.textOn : textState.str.trim() !== "";
  const textTexUse = ov ? (ov.textTex || clearTex) : (textOn ? textTex : clearTex);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, textTexUse);
  gl.uniform1i(u.u_text, 2);
  gl.uniform1f(u.u_textOn, textOn ? 1 : 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function frame() {
  if (seqPlaying && slides.length) {
    const el = performance.now() - seqPlaying.start;
    const n = slides.length;
    const total = n * seqPlaying.hold + (n - 1) * seqPlaying.trans;
    const s = seqAt(Math.min(el, total), n, seqPlaying.hold, seqPlaying.trans, seqState.zoom);
    seqFrame = {
      texA: slides[s.a].tex,
      texB: slides[s.b].tex,
      t: s.t,
      zoomA: s.zoomA,
      zoomB: s.zoomB,
    };
    seqOverride = overrideFor(s.a, s.b, s.t);
    dirty = true;
    if (el >= total + 300 && seqPlaying.onend) {
      const f = seqPlaying.onend;
      seqPlaying.onend = null;
      f();
    }
  } else if (previewMode) {
    if (!slides.length) {
      setPreviewMode(false);
    } else {
      const n = slides.length;
      const holdMs = seqState.hold * 1000;
      const transMs = seqState.trans * 1000;
      const total = n * holdMs + (n - 1) * transMs;
      const el = total > 0 ? (performance.now() - previewStart) % (total + 300) : 0;
      const s = seqAt(Math.min(el, total), n, holdMs, transMs, seqState.zoom);
      seqFrame = {
        texA: slides[s.a].tex,
        texB: slides[s.b].tex,
        t: s.t,
        zoomA: s.zoomA,
        zoomB: s.zoomB,
      };
      seqOverride = overrideFor(s.a, s.b, s.t);
      dirty = true;
    }
  }
  const needsAnim = animate && originalData &&
    ((enabled.glitch && state.glitch > 0) ||
     (enabled.grain && state.noise > 0) ||
     (enabled.crt && (state.track > 0 || state.wobble > 0)));
  if (dirty || needsAnim) {
    render(animate ? performance.now() / 1000 : frozenTime);
    dirty = false;
    if (seqPlaying?.blit) seqPlaying.blit();
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
  return { enabled: { ...enabled }, state: { ...state }, seed, text: { ...textState } };
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
// 画像は既定で非公開。一覧取得時に受け取る期限付き署名をURLに付けて読む
let imgExp = "0";
let sigRetried = false;
const workImgUrl = (w, kind) =>
  `/api/works/${w.id}/${kind}?e=${encodeURIComponent(imgExp)}&s=${encodeURIComponent(w.sig || "")}`;
const keyHeaders = () => ({ "x-gallery-key": galleryKey() });

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
    const { works, imgExp: exp } = await res.json();
    lastWorks = works;
    if (exp) {
      imgExp = String(exp);
      sigRetried = false; // 新しい署名を取り直せたのでリトライ枠を戻す
    }
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
        `<img loading="lazy" src="${workImgUrl(w, "thumb")}" alt="" />` +
        `<div class="work-meta"><span>${label}</span><button class="work-del" title="削除">✕</button></div>`;
      const imgEl = el.querySelector("img");
      imgEl.addEventListener("click", () => loadWork(w));
      // 署名の期限切れ（長時間開きっぱなし）なら一度だけ取り直す
      imgEl.addEventListener("error", () => {
        if (sigRetried) return;
        sigRetried = true;
        refreshGallery();
      });
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
    applyTextRecipe(w.recipe.text);
    const res = await fetch(`/api/works/${w.id}/source`, { headers: keyHeaders() });
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
  if (!graphMode) suggestPanel.hidden = true;
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
    const url = workImgUrl(w, "thumb");
    if (!img) {
      img = new Image();
      img.src = url;
      thumbCache.set(w.id, img);
    } else if (img.dataset?.url !== url && !img.complete) {
      img.src = url; // 署名が更新されていたら読み直す
    }
    if (img.dataset) img.dataset.url = url;
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
  return { enabled: en, state: st, seed: Math.random() * 100, text: ra?.text ?? null };
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
  return { enabled: en, state: st, seed: Math.random() * 100, text: r?.text ?? null };
}

async function spawnChild(recipe, baseWork, parents) {
  try {
    // レシピを先に適用（ピクセルソートはソース読み込み時に反映されるため）
    Object.assign(state, DEFAULTS, recipe.state);
    for (const k of Object.keys(enabled)) enabled[k] = !!recipe.enabled[k];
    seed = recipe.seed ?? Math.random() * 100;
    syncUI();
    applyTextRecipe(recipe.text);
    const res = await fetch(`/api/works/${baseWork.id}/source`, { headers: keyHeaders() });
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

// ---------------------------------------------------------------- 提案（グラフの穴 → 次の一手）

const suggestPanel = document.getElementById("suggest-panel");
const suggestBtn = document.getElementById("btn-suggest");

// 類似エッジから連結成分（作品の「島」）を求める
function graphComponents(n, edges) {
  const parent = [...Array(n).keys()];
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  for (const e of edges) {
    const ra = find(e.a), rb = find(e.b);
    if (ra !== rb) parent[ra] = rb;
  }
  const comps = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r).push(i);
  }
  return [...comps.values()];
}

function pairSim(i, j, rvecs) {
  const a = gNodes[i].work, b = gNodes[j].work;
  const rs = Math.max(0, cosine(rvecs[i], rvecs[j]));
  if (Array.isArray(a.embedding) && Array.isArray(b.embedding)) {
    const es = Math.min(1, Math.max(0, (cosine(a.embedding, b.embedding) - 0.55) / 0.4));
    return 0.6 * es + 0.4 * rs;
  }
  return rs * 0.8;
}

const shortCap = (w) => (w.caption || w.prompt || "無題").slice(0, 42);

// グラフの構造的な穴を検出する。LLMには渡さず先に機械的な提案として出せる形にする。
function analyzeGaps() {
  const N = gNodes.length;
  const gaps = [];
  if (!N) return gaps;
  const rvecs = gNodes.map((n) => recipeVec(n.work.recipe));

  // A: 離れたまとまりどうしの橋渡し。
  // 表示用エッジは各ノードの上位3件なので必ずほぼ連結になる。
  // 強い類似(0.5以上)だけを残して初めて本当の「まとまり」が見える。
  const STRONG = 0.5;
  const comps = graphComponents(N, gEdges.filter((e) => e.w >= STRONG));
  if (comps.length >= 2) {
    let best = null;
    for (let ci = 0; ci < comps.length; ci++) {
      for (let cj = ci + 1; cj < comps.length; cj++) {
        for (const i of comps[ci]) {
          for (const j of comps[cj]) {
            const s = pairSim(i, j, rvecs);
            if (!best || s > best.s) best = { s, i, j };
          }
        }
      }
    }
    if (best) {
      const A = gNodes[best.i].work, B = gNodes[best.j].work;
      gaps.push({
        kind: "bridge",
        kindLabel: "離れたまとまり",
        title: "2つの系統をつなぐ作品",
        why: `「${shortCap(A)}」側と「${shortCap(B)}」側の間が空いています`,
        desc: `The collection splits into ${comps.length} loosely related groups. The closest pair across groups is "${shortCap(A)}" and "${shortCap(B)}". A work sitting between these two would fill the space between the groups.`,
        bridge: [best.i, best.j],
      });
    }
  }

  // B: 個別には使ったのにペアで使っていないエフェクトの組み合わせ
  const useCount = {};
  const pairSeen = new Set();
  for (const n of gNodes) {
    const en = n.work.recipe?.enabled ?? {};
    const on = MODULES.filter((m) => en[m.id]).map((m) => m.id);
    for (const id of on) useCount[id] = (useCount[id] ?? 0) + 1;
    for (let a = 0; a < on.length; a++) {
      for (let b = a + 1; b < on.length; b++) {
        pairSeen.add([on[a], on[b]].sort().join("|"));
      }
    }
  }
  const combos = [];
  for (let a = 0; a < MODULES.length; a++) {
    for (let b = a + 1; b < MODULES.length; b++) {
      const ma = MODULES[a], mb = MODULES[b];
      const ua = useCount[ma.id] ?? 0, ub = useCount[mb.id] ?? 0;
      if (ua < 1 || ub < 1) continue;
      if (pairSeen.has([ma.id, mb.id].sort().join("|"))) continue;
      // 両方よく使うのに一緒に使っていない組ほど上位。同点はランダムで揺らす
      combos.push({ ma, mb, score: ua + ub + Math.random() * 0.6 });
    }
  }
  combos.sort((x, y) => y.score - x.score);
  for (const c of combos.slice(0, 2)) {
    gaps.push({
      kind: "combo",
      kindLabel: "未使用の組み合わせ",
      title: `${c.ma.name} × ${c.mb.name}`,
      why: `${c.ma.jp}と${c.mb.jp}を同時に使った作品がまだありません`,
      desc: `The effects "${c.ma.name} (${c.ma.jp})" and "${c.mb.name} (${c.mb.jp})" have each been used separately but never together in one work.`,
      combo: [c.ma.id, c.mb.id],
    });
  }

  // 一度も使っていないエフェクト
  const never = MODULES.filter((m) => !useCount[m.id]);
  if (never.length && gaps.length < 4) {
    const m = never[Math.floor(Math.random() * never.length)];
    gaps.push({
      kind: "unused",
      kindLabel: "未使用のエフェクト",
      title: `${m.name} をまだ使っていない`,
      why: `${m.jp}を使った作品が1つもありません`,
      desc: `The effect "${m.name} (${m.jp})" has never been used in any work.`,
      combo: [m.id],
    });
  }

  // C: まだ一度も掛け合わせていない作品
  if (gaps.length < 4) {
    const parents = new Set();
    for (const n of gNodes) {
      if (n.work.parent_a) parents.add(n.work.parent_a);
      if (n.work.parent_b) parents.add(n.work.parent_b);
    }
    const unbred = gNodes.filter((n) => !parents.has(n.id));
    if (unbred.length) {
      const w = unbred[0].work;
      gaps.push({
        kind: "unbred",
        kindLabel: "未交配",
        title: "まだ枝分かれしていない作品",
        why: `「${shortCap(w)}」から派生した作品がまだありません`,
        desc: `The work "${shortCap(w)}" has never been used as a parent. Its lineage has no branches yet.`,
        mutate: gNodes.indexOf(unbred[0]),
      });
    }
  }

  return gaps.slice(0, 4);
}

function suggestionRecipe(gap) {
  const e = {};
  for (const id of gap.combo || []) e[id] = true;
  return { e, s: {}, seed: Math.random() * 100, t: { ...TEXT_DEFAULTS } };
}

function renderSuggestions(gaps, loading) {
  suggestPanel.hidden = false;
  suggestPanel.innerHTML = "";
  const head = document.createElement("p");
  head.className = "sg-head";
  head.textContent = loading
    ? `${gaps.length}件の穴を検出。AIが提案を書いています…`
    : `${gaps.length}件の穴と、それを埋める提案`;
  suggestPanel.appendChild(head);

  gaps.forEach((gap, idx) => {
    const card = document.createElement("div");
    card.className = "sg-card";
    card.innerHTML =
      `<div class="sg-kind">${gap.kindLabel}</div>` +
      `<div class="sg-title"></div><div class="sg-why"></div>` +
      `<div class="sg-actions"></div>`;
    card.querySelector(".sg-title").textContent = gap.ai?.title
      ? `${gap.ai.title}（${gap.title}）`
      : gap.title;
    card.querySelector(".sg-why").textContent = gap.ai?.why || gap.why;
    const acts = card.querySelector(".sg-actions");
    const mk = (label, fn) => {
      const b = document.createElement("button");
      b.className = "btn";
      b.textContent = label;
      b.addEventListener("click", fn);
      acts.appendChild(b);
    };

    if (gap.bridge) {
      const A = gNodes[gap.bridge[0]], B = gNodes[gap.bridge[1]];
      if (A && B) {
        mk("◇ 掛け合わせる", () =>
          spawnChild(crossRecipes(A.work.recipe, B.work.recipe), A.work, [A.id, B.id]));
      }
    }
    if (gap.combo) {
      mk("このレシピで作る", () => {
        applyRecipeObject(suggestionRecipe(gap));
        closeGallery();
      });
    }
    if (typeof gap.mutate === "number") {
      const n = gNodes[gap.mutate];
      if (n) mk("⚡ 突然変異", () => spawnChild(mutateRecipe(n.work.recipe), n.work, [n.id]));
    }
    if (gap.ai?.scenePrompt) {
      mk("シーンを作る", async () => {
        if (gap.combo) applyRecipeObject(suggestionRecipe(gap));
        aiPrompt.value = gap.ai.scenePrompt;
        closeGallery();
        await generateScene();
      });
    }
    suggestPanel.appendChild(card);
  });

  if (loading) {
    const p = document.createElement("p");
    p.className = "sg-loading";
    p.textContent = "AIの提案が届くと、タイトルと「シーンを作る」ボタンが追加されます。";
    suggestPanel.appendChild(p);
  }
}

async function runSuggest() {
  if (!gNodes.length) {
    setGalleryNote("提案にはカットではなく保存作品が必要です。", true);
    return;
  }
  suggestBtn.disabled = true;
  suggestBtn.textContent = "分析中…";
  const gaps = analyzeGaps();
  if (!gaps.length) {
    suggestPanel.hidden = false;
    suggestPanel.innerHTML = '<p class="sg-head">目立った穴は見つかりませんでした。作品を増やすと精度が上がります。</p>';
    suggestBtn.disabled = false;
    suggestBtn.textContent = "◇ 次の一手";
    return;
  }
  // まず機械的な提案を出し、AIの言語化は後から差し込む（AI枠切れでも機能する）
  renderSuggestions(gaps, true);
  try {
    const res = await fetch("/api/suggest", {
      method: "POST",
      headers: { "content-type": "application/json", "x-gallery-key": galleryKey() },
      body: JSON.stringify({
        captions: gNodes.map((n) => n.work.caption).filter(Boolean),
        gaps: gaps.map((g) => ({ kind: g.kind, desc: g.desc })),
      }),
    });
    if (res.ok) {
      const { suggestions } = await res.json();
      if (Array.isArray(suggestions)) {
        suggestions.forEach((s, i) => {
          if (gaps[i] && s && typeof s === "object") {
            gaps[i].ai = {
              title: typeof s.title === "string" ? s.title.slice(0, 40) : null,
              why: typeof s.why === "string" ? s.why.slice(0, 80) : null,
              scenePrompt: typeof s.scenePrompt === "string" ? s.scenePrompt.slice(0, 60) : null,
            };
          }
        });
      }
    }
  } catch { /* AIが使えなくても機械的な提案は表示済み */ }
  renderSuggestions(gaps, false);
  suggestBtn.disabled = false;
  suggestBtn.textContent = "◇ 次の一手";
}
suggestBtn.addEventListener("click", runSuggest);

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
  x.fillText("NOIZ", w / 2, h * 0.88);
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

// シーン生成で検証済みの仕様を組み込みサンプルとしても提供する
const SCENE_SAMPLE_SPECS = [
  { // 桜×鳥居
    sky: ["#4a2c5e", "#c66a8a", "#ffb98a"], horizon: 0.7,
    celestial: { type: "sun", x: 0.35, y: 0.45, r: 0.07, color: "#ffdca0", glow: "#ff8a5c" },
    stars: 0, clouds: { count: 3, color: "#7a4a6e" },
    ground: { type: "plain", colors: ["#241530"] },
    sakura: 90, birds: 3,
    torii: { x: 0.5, size: 0.42, color: "#2e0f1c" },
  },
  { // 夏祭りの花火
    sky: ["#0a0c1c", "#1a1f3c", "#2c2350"], horizon: 0.68,
    celestial: { type: "none" }, stars: 120,
    clouds: { count: 1, color: "#1e2240" },
    ground: { type: "sea", colors: ["#0a0c14"] },
    fireworks: [
      { x: 0.3, y: 0.2, r: 0.1, color: "#ff69b4" },
      { x: 0.7, y: 0.3, r: 0.12, color: "#33ccff" },
      { x: 0.5, y: 0.14, r: 0.08, color: "#ffd75d" },
    ],
  },
  { // 雨のネオン街
    sky: ["#07070f", "#141024", "#1c1230"], horizon: 0.72,
    celestial: { type: "none" }, stars: 0,
    clouds: { count: 2, color: "#221a38" },
    ground: { type: "city", colors: ["#0b0b14"] },
    rain: 160,
    signs: [
      { text: "深夜", color: "#ff3ea5", x: 0.2, y: 0.28 },
      { text: "ラーメン", color: "#35e0ff", x: 0.75, y: 0.4 },
    ],
  },
  { // オーロラ雪原
    sky: ["#0b1026", "#16204a", "#243a66"], horizon: 0.72,
    celestial: { type: "moon", x: 0.78, y: 0.16, r: 0.05, color: "#ffffff", glow: "#9ecbff" },
    stars: 130, clouds: { count: 0, color: "#ffffff" },
    ground: { type: "mountains", colors: ["#e8ecf4", "#b9c2d4", "#7c88a6", "#4a5474"] },
    snow: 170,
    aurora: { colors: ["#5dffb0", "#7a6bff", "#34a8ff"] },
  },
];

const SAMPLES = [
  drawSunsetGrid, drawNeonAlley, drawMoonSea, drawDuskMountains,
  ...SCENE_SAMPLE_SPECS.map((spec) => (x, w, h) => drawSceneSpec(x, w, h, spec)),
];
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
// レシピURL（#r=）はプリセット・文字ハッシュより優先して全設定を復元する
const recipeHashMatch = location.hash.match(/r=([A-Za-z0-9_-]+)/);
if (recipeHashMatch && recipeHashMatch[1].length < 4000) {
  try {
    applyRecipeObject(JSON.parse(b64urlDecode(recipeHashMatch[1])));
  } catch { /* 不正なレシピURLは無視 */ }
}
// PWA: オフライン時のフォールバック用Service Worker（ネットワーク優先）
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => { /* 非対応環境は無視 */ });
}
// 文字入れもハッシュ指定可（例: /#text=夏の終わり|1999）。#r=がある場合はそちらを優先
const textHashMatch = recipeHashMatch ? null : location.hash.match(/text=([^&]+)/);
if (textHashMatch && textHashMatch[1].length < 200) {
  try {
    textState.str = decodeURIComponent(textHashMatch[1]).slice(0, 60);
    syncTextUI();
    updateTextTexture();
    canvas.classList.add("text-drag");
  } catch { /* 無視 */ }
}
