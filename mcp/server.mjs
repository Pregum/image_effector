#!/usr/bin/env node
// NOIZ LAB MCP server (stdio). Hand-written JSON-RPC so the repo keeps its
// zero-dependency policy: node mcp/server.mjs is all it takes to run.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  CONSTANTS, ToolError, applyStyleBible, buildShortVideo, createProjectFromBrief,
  embedLocalAssets, generateMissingAssets, generateStoryboard, materializeAssets,
  renderProject, reviewHookAndPacing, validateProjectTool,
} from "./tools.mjs";

const SERVER_INFO = { name: "noiz-lab", title: "NOIZ LAB", version: "1.0.0" };
// Advertise the version we implement; if the client asks for a different one we
// echo the latest we support and let it decide, per the lifecycle spec.
const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOLS = new Set([PROTOCOL_VERSION, "2025-03-26", "2024-11-05"]);

const { PRESETS, TRANSITIONS, PLATFORMS, PURPOSES, MOTIONS } = CONSTANTS;

const projectSchema = { type: "object", description: "NOIZ LAB Project JSON (schemas/project.schema.json)" };

const TOOLS = [
  {
    name: "create_project_from_brief",
    title: "Create project from brief",
    description: "目的・対象視聴者・尺・投稿先から NOIZ LAB Project JSON を作り、必要なカット数と推奨プリセットを含む構成案を返します。素材はまだ入りません。",
    inputSchema: {
      type: "object",
      required: ["objective"],
      properties: {
        objective: { type: "string", maxLength: 1000, description: "動画の目的。例: 新しいメモアプリを15秒で紹介したい" },
        audience: { type: "string", maxLength: 500, description: "想定視聴者" },
        platform: { enum: PLATFORMS, description: "投稿先。既定は generic", default: "generic" },
        duration: { type: "number", minimum: 0, maximum: 3600, description: "目標の尺（秒）。既定は15" },
        mood: { type: "array", maxItems: 16, items: { type: "string", maxLength: 80 }, description: "雰囲気。例: [\"ノスタルジック\", \"夜\"]" },
        language: { type: "string", maxLength: 16, description: "字幕・UIの言語。既定は ja" },
        title: { type: "string", maxLength: 160, description: "プロジェクト名。省略時は objective から生成" },
      },
      additionalProperties: false,
    },
    handler: createProjectFromBrief,
  },
  {
    name: "generate_storyboard",
    title: "Generate storyboard",
    description: "フック・展開・締めを含む絵コンテを作ります。自分で書いた絵コンテを storyboard で渡すか、NOIZ LABのデプロイ先を endpoint で指定してサーバー側のLLMに書かせるか、どちらでも動きます。project を渡すと字幕とプリセットを取り込みます。",
    inputSchema: {
      type: "object",
      properties: {
        project: { ...projectSchema, description: "省略可。渡すと絵コンテを取り込んだプロジェクトを返します" },
        storyboard: {
          type: "object",
          description: "自分で書いた絵コンテ。endpoint より優先されます。",
          required: ["cuts"],
          properties: {
            title: { type: "string", maxLength: 160 },
            logline: { type: "string", maxLength: 200 },
            cuts: {
              type: "array",
              minItems: 1,
              maxItems: 8,
              items: {
                type: "object",
                properties: {
                  purpose: { enum: PURPOSES },
                  duration: { type: "number", minimum: 0.5, maximum: 6 },
                  shot: { type: "string", maxLength: 200, description: "画の内容" },
                  caption: { type: "string", maxLength: 60, description: "画面に出す字幕" },
                  imagePrompt: { type: "string", maxLength: 400, description: "画像生成用の英語プロンプト" },
                  preset: { enum: PRESETS },
                  motion: { enum: MOTIONS, description: "docs/motion-grammar.md の技法ID" },
                  transitionOut: { enum: [...TRANSITIONS, null], description: "最後のカットは null" },
                },
              },
            },
          },
        },
        endpoint: { type: "string", maxLength: 2048, description: "NOIZ LABのURL。例: https://image-effector.example.workers.dev" },
        objective: { type: "string", maxLength: 1000, description: "省略時は project.brief.objective" },
        duration: { type: "number", minimum: 0, maximum: 3600, description: "目標の尺（秒）。カット尺はこれに合わせて調整されます" },
        platform: { enum: PLATFORMS },
        audience: { type: "string", maxLength: 500 },
        mood: { type: "array", maxItems: 8, items: { type: "string", maxLength: 80 } },
        language: { type: "string", maxLength: 16, description: "字幕の言語。既定は ja" },
        timeoutMs: { type: "number", minimum: 1000, maximum: 120000, description: "endpoint 使用時のタイムアウト。既定は60000" },
        keepTitle: { type: "boolean", default: false, description: "true にすると絵コンテのタイトルでプロジェクト名を上書きしません" },
      },
      additionalProperties: false,
    },
    handler: generateStoryboard,
  },
  {
    name: "generate_missing_assets",
    title: "Generate missing assets",
    description: "絵コンテのカットに対応する画像をCloudflare Workers AIで生成し、ファイルへ書き出してプロジェクトへ追加します。NOIZ LABのデプロイ先（endpoint）が必要です。1回につき最大8枚、数分かかります。",
    inputSchema: {
      type: "object",
      required: ["endpoint", "outDir"],
      properties: {
        endpoint: { type: "string", maxLength: 2048, description: "NOIZ LABのURL。例: https://image-effector.example.workers.dev" },
        outDir: { type: "string", maxLength: 2048, description: "生成した画像の保存先ディレクトリ" },
        project: { ...projectSchema, description: "省略可。渡すと生成した画像を素材として追加します" },
        storyboard: { type: "object", description: "generate_storyboard の結果。各カットの imagePrompt から生成します" },
        prompts: {
          type: "array",
          maxItems: 8,
          items: { type: "string", maxLength: 500 },
          description: "storyboard の代わりに、生成したい画像のプロンプトを直接指定します（英語推奨。日本語はサーバー側で英訳されます）",
        },
        style: { type: "string", maxLength: 300, description: "全プロンプトへ共通で足す作風。省略時は styleBible から組み立てます" },
        negativePrompt: { type: "string", maxLength: 300, description: "避けたい表現。省略時は styleBible のもの" },
        steps: { type: "number", minimum: 4, maximum: 8, description: "生成ステップ数。既定は6" },
        styleBible: { type: "object", description: "project を渡さない場合の作風指定" },
        timeoutMs: { type: "number", minimum: 5000, maximum: 600000, description: "タイムアウト。既定は300000 (5分)" },
      },
      additionalProperties: false,
    },
    handler: generateMissingAssets,
  },
  {
    name: "apply_style_bible",
    title: "Apply style bible",
    description: "配色・照明・画角・タイポなどのスタイルバイブルをプロジェクトへ設定し、preset を指定すると全カットのレシピへ統一適用します。",
    inputSchema: {
      type: "object",
      required: ["project", "styleBible"],
      properties: {
        project: projectSchema,
        styleBible: {
          type: "object",
          description: "設定する項目だけ渡せます。未指定の項目は既存値を保ちます。",
          properties: {
            preset: { enum: PRESETS, description: "全カットへ適用するエフェクトプリセット" },
            palette: { type: "array", maxItems: 12, items: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" } },
            subjects: { type: "array", items: { type: "object" } },
            lighting: { type: "string", maxLength: 300 },
            camera: { type: "string", maxLength: 300 },
            texture: { type: "array", maxItems: 16, items: { type: "string", maxLength: 80 } },
            typography: { type: "object" },
            references: { type: "array", maxItems: 16, items: { type: "string", maxLength: 128 } },
            negativePrompt: { type: "string", maxLength: 1000 },
            seed: { type: "number" },
          },
        },
        overwriteCutRecipes: { type: "boolean", default: true, description: "false にすると既にプリセットを持つカットを上書きしません" },
      },
      additionalProperties: false,
    },
    handler: applyStyleBible,
  },
  {
    name: "build_short_video",
    title: "Build short video timeline",
    description: "素材をタイムラインへ並べ、BPMに合わせたカット割りとトランジションを設定します。BPMを渡すと拍にスナップします。カットは最大8つ。",
    inputSchema: {
      type: "object",
      required: ["project"],
      properties: {
        project: projectSchema,
        assets: {
          type: "array",
          maxItems: 9,
          description: "追加する素材。既にプロジェクトへ入っている場合は省略できます。",
          items: {
            type: "object",
            required: ["path"],
            properties: {
              path: { type: "string", maxLength: 2048, description: "ローカルファイルパス" },
              type: { enum: ["image", "video", "audio", "generated-image", "generated-scene"], default: "image" },
              name: { type: "string", maxLength: 300 },
              mime: { type: "string", maxLength: 120 },
            },
            additionalProperties: false,
          },
        },
        duration: { type: "number", minimum: 0, maximum: 3600, description: "全体の尺（秒）。省略時は brief.duration" },
        bpm: { type: "number", minimum: 0, maximum: 400, description: "0以外を渡すとカット尺を拍へスナップします" },
        beatDivision: { enum: [1, 2, 4, 8, 16], description: "何拍ごとにカットを割るか" },
        transitions: { type: "array", maxItems: 8, items: { enum: TRANSITIONS }, description: "順に巡回して使うトランジション" },
        transitionDuration: { type: "number", minimum: 0.2, maximum: 2, description: "トランジションの秒数。既定は0.9" },
        purposes: { type: "array", maxItems: 8, items: { enum: PURPOSES }, description: "各カットの役割。省略時は hook/explain/cta を自動割り当て" },
        storyboard: { type: "object", description: "generate_storyboard の結果。渡すとカットごとの尺・役割・演出・つなぎがそのまま反映され、素材数と一致する必要があります" },
      },
      additionalProperties: false,
    },
    handler: buildShortVideo,
  },
  {
    name: "review_hook_and_pacing",
    title: "Review hook and pacing",
    description: "冒頭の掴み、カットの緩急、尺、字幕、縦横比を検査し、重大度つきの指摘と0-100のスコアを返します。",
    inputSchema: {
      type: "object",
      required: ["project"],
      properties: { project: projectSchema },
      additionalProperties: false,
    },
    handler: reviewHookAndPacing,
  },
  {
    name: "validate_project",
    title: "Validate project",
    description: "Project JSON が共通スキーマに沿っているか検証し、問題があれば箇所を返します。",
    inputSchema: {
      type: "object",
      required: ["project"],
      properties: { project: projectSchema },
      additionalProperties: false,
    },
    handler: validateProjectTool,
  },
  {
    name: "render_project",
    title: "Render project to MP4",
    description: "プロジェクトのタイムラインを実際にMP4へ書き出します。ヘッドレスChromeとffmpegが必要で、素材は source.kind=local のみ対応。数分かかります。",
    inputSchema: {
      type: "object",
      required: ["project", "output"],
      properties: {
        project: projectSchema,
        output: { type: "string", maxLength: 2048, description: "出力先の .mp4 パス" },
        timeoutMs: { type: "number", minimum: 10000, maximum: 1800000, description: "書き出しのタイムアウト。既定は900000 (15分)" },
      },
      additionalProperties: false,
    },
    handler: renderProject,
  },
  {
    name: "read_project",
    title: "Read project file",
    description: "ディスク上の Project JSON を読み込んで検証し、そのまま他のツールへ渡せる形で返します。",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", maxLength: 2048, description: "読み込む .json のパス" },
        extractAssetsTo: {
          type: "string",
          maxLength: 2048,
          description: "埋め込み素材を展開するディレクトリ。Web版で保存したプロジェクトを render_project へ渡すときに指定します",
        },
      },
      additionalProperties: false,
    },
    handler: async ({ path, extractAssetsTo }) => {
      if (typeof path !== "string" || !path.trim()) throw new ToolError("path must be a non-empty string");
      let text;
      try { text = await readFile(resolve(path), "utf8"); }
      catch (error) { throw new ToolError(`could not read ${path}: ${error.message}`); }
      let project;
      try { project = JSON.parse(text); }
      catch { throw new ToolError(`${path} is not valid JSON`); }
      const { valid, errors } = validateProjectTool({ project });
      if (!valid) throw new ToolError(`${path} is not a valid NOIZ LAB project: ${errors.slice(0, 4).join(" / ")}`);
      // render_project needs files on disk, so a project saved by the Web app
      // (everything embedded) has to be unpacked before it can be rendered.
      if (typeof extractAssetsTo === "string" && extractAssetsTo.trim()) {
        const { project: out, materialized } = await materializeAssets(project, resolve(extractAssetsTo));
        return { project: out, materializedAssets: materialized };
      }
      const embedded = project.assets.filter((a) => a.source.kind === "embedded").length;
      return {
        project,
        ...(embedded ? {
          note: `${embedded}件の素材がJSONへ埋め込まれています。render_project へ渡すには extractAssetsTo でファイルへ展開してください。`,
        } : {}),
      };
    },
  },
  {
    name: "write_project",
    title: "Write project file",
    description: "Project JSON を検証してからディスクへ保存します。既定でローカル素材をJSONへ埋め込むので、Web版の「↑ JSONを開く」でそのまま開けます（素材は合計150MBまで）。",
    inputSchema: {
      type: "object",
      required: ["project", "path"],
      properties: {
        project: projectSchema,
        path: { type: "string", maxLength: 2048, description: "保存先の .json パス。Web版が既定で書き出すのは .noiz.json です" },
        embedAssets: {
          type: "boolean",
          default: true,
          description: "true（既定）でローカル素材をbase64で埋め込みます。false にするとファイルパス参照のままになり、Web版では開けません",
        },
      },
      additionalProperties: false,
    },
    handler: async ({ project, path, embedAssets = true }) => {
      if (typeof path !== "string" || !path.trim()) throw new ToolError("path must be a non-empty string");
      const { valid, errors } = validateProjectTool({ project });
      if (!valid) throw new ToolError(`refusing to write an invalid project: ${errors.slice(0, 4).join(" / ")}`);
      let out = structuredClone(project);
      let embedded = 0;
      if (embedAssets) ({ project: out, embedded } = await embedLocalAssets(out));
      // Embedding can push a valid project past the schema's per-asset cap.
      const after = validateProjectTool({ project: out });
      if (!after.valid) throw new ToolError(`embedding produced an invalid project: ${after.errors.slice(0, 4).join(" / ")}`);
      const target = resolve(path);
      const text = JSON.stringify(out, null, 2) + "\n";
      // Create the parent directory rather than failing with a raw ENOENT; the
      // caller naming a path that does not exist yet is normal.
      await mkdir(dirname(target), { recursive: true });
      try { await writeFile(target, text, "utf8"); }
      catch (error) { throw new ToolError(`could not write ${target}: ${error.message}`); }
      const local = out.assets.filter((a) => a.source.kind === "local").length;
      return {
        path: target,
        bytes: text.length,
        embeddedAssets: embedded,
        // A file with local paths left in it will not open in the browser; say
        // so here rather than letting the user find out in the Web app.
        openableInWebApp: local === 0,
        ...(local ? { note: `${local}件の素材がファイルパス参照のままです。Web版で開くには embedAssets を true にしてください。` } : {}),
      };
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export const TOOL_DEFINITIONS = TOOLS.map(({ handler, ...rest }) => rest);

export async function callTool(name, args) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) throw new ToolError(`Unknown tool: ${name}`);
  return tool.handler(args ?? {});
}

// --- JSON-RPC plumbing -----------------------------------------------------

const send = (message) => { process.stdout.write(JSON.stringify(message) + "\n"); };
const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
const respondError = (id, code, message, data) => {
  send({ jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } });
};

async function handleRequest(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    const requested = params?.protocolVersion;
    // Spec: answer with the same version when we support it, otherwise ours.
    const version = SUPPORTED_PROTOCOLS.has(requested) ? requested : PROTOCOL_VERSION;
    respond(id, {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: "NOIZ LAB のショート動画プロジェクトを組み立てます。create_project_from_brief で構成案を作り、generate_storyboard で絵コンテを起こし、素材が無ければ generate_missing_assets で生成し、build_short_video で素材を並べ、review_hook_and_pacing で確認してから render_project でMP4を書き出します。プロジェクトは各ツールの戻り値の project をそのまま次のツールへ渡してください。絵コンテはあなた自身が書いて storyboard に渡せます（バックエンド不要）。",
    });
    return;
  }

  if (method === "ping") { respond(id, {}); return; }

  if (method === "tools/list") { respond(id, { tools: TOOL_DEFINITIONS }); return; }

  if (method === "tools/call") {
    const name = params?.name;
    if (!TOOL_BY_NAME.has(name)) {
      respondError(id, -32602, `Unknown tool: ${name}`);
      return;
    }
    try {
      const result = await callTool(name, params?.arguments);
      const text = JSON.stringify(result, null, 2);
      respond(id, { content: [{ type: "text", text }], structuredContent: result, isError: false });
    } catch (error) {
      // Bad input and failed renders are tool execution errors, not protocol
      // errors: the model should see them and correct course.
      respond(id, {
        content: [{ type: "text", text: error instanceof ToolError ? error.message : `内部エラー: ${error.message}` }],
        isError: true,
      });
    }
    return;
  }

  respondError(id, -32601, `Method not found: ${method}`);
}

function handleMessage(message) {
  if (!message || message.jsonrpc !== "2.0") return;
  // Notifications (no id) get no reply — including notifications/initialized.
  if (message.id === undefined || message.id === null) return;
  if (typeof message.method !== "string") return;
  handleRequest(message).catch((error) => {
    respondError(message.id, -32603, `Internal error: ${error.message}`);
  });
}

function main() {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { respondError(null, -32700, "Parse error"); continue; }
      handleMessage(message);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
