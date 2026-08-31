# Changelog

このプロジェクトの主な変更点を記録します。
*Notable changes to this project. English summary follows the Japanese section of each release.*

## [1.1.0] — 2026-08-31

Webのエディタに加えて、**エージェントやコマンドラインから扱える制作環境**が加わりました。
JSONのプロジェクト形式を共通の器にすることで、CLI・MCP・Web版が同じ作品を行き来できます。

### エージェント向けのインターフェース
- 可搬なプロジェクト形式（`schemas/project.schema.json` / `public/project-format.js`）。
  カット・エフェクト・モーション・トランジションをJSONで表現し、
  MCPで作ったプロジェクトをWeb版でそのまま開ける
- MCPサーバー（`mcp/`）から企画・編集・レビュー・書き出しを操作できるツール群:
  `create_project_from_brief` / `generate_storyboard` / `generate_missing_assets` /
  `apply_style_bible` / `build_short_video` / `render_project` /
  `review_hook_and_pacing` / `read_project` / `write_project` / `validate_project`
- コマンドラインからエフェクト適用と動画書き出しを行うCLI（`scripts/noizlab-effect.mjs`、
  `scripts/noizlab-variety-video.mjs`）と、macOSのウィンドウを収録する補助スクリプト
- Claude Code / エージェント向けのスキル `noiz-lab-effects` を同梱

### AIによる制作支援
- AI絵コンテ生成（`POST /api/storyboard`）。企画文からカット構成を組み立てる
- 不足素材のAI生成（`POST /api/assets`）。絵コンテに対して足りないカットだけを補う

### モーション文法
カットの動きを語彙として定義し（`docs/motion-grammar.md`）、レンダラーで実装しました。

- カメラ系5種 — `orthographic-pullback` / `constant-linear` / `frame-echo` /
  `modular-grid` / `ken-burns`
- 表面表現2種 — `halftone`（網点）/ `cmyk-misregistration`（版ズレ）。カメラ系に重ねられる
- 接続技法4種 — `track-matte` / `radial-wipe` / `silhouette-match` / `match-cut`

### その他
- アイコンをNマークに刷新し、faviconと統一（1024pxを追加）
- 利用状況の匿名計測（Cookieや識別IDを使わず、機能名のみ。バインディングが無ければ無効）
- 説明ページの記述を計測の実態に合わせて修正

---

### English summary

Beyond the web editor, NOIZ LAB now has an **agent- and CLI-facing production
environment**. A JSON project format acts as the shared container, so the CLI, the MCP
server and the web app can all hand the same piece back and forth.

- **Portable project format** — cuts, effects, motion and transitions expressed as JSON;
  a project built over MCP opens directly in the web app.
- **MCP server** with tools for planning, editing, review and export
  (`create_project_from_brief`, `generate_storyboard`, `generate_missing_assets`,
  `apply_style_bible`, `build_short_video`, `render_project`, `review_hook_and_pacing`,
  and read/write/validate).
- **CLI** for applying effects and exporting videos, plus a helper that records a macOS
  window, and a bundled `noiz-lab-effects` skill for agents.
- **AI assistance** — storyboard generation (`POST /api/storyboard`) and generation of
  only the assets a storyboard is missing (`POST /api/assets`).
- **Motion grammar** (`docs/motion-grammar.md`) implemented in the renderer: five camera
  techniques, two surface techniques (halftone, CMYK misregistration) that layer on top,
  and four connection techniques including match-cut.
- Icon refreshed to the N mark; anonymous, ID-free usage counting that disables itself
  when the binding is absent.

## [1.0.0] — 2026-08-20

最初の公開リリース。ブラウザだけで完結する画像エフェクトツールとして、
素材づくりから加工・仕上げ・動画書き出し・作品管理までが一通り揃いました。

### エフェクト・加工
- WebGL2のマルチパスシェーダーによるエフェクト11種
  （ぼかし / ピクセルソート / グリッチ / 色収差 / ハレーション / 色調エモ化 /
  光漏れ / モザイク / ディザ・網点・アスキーアート / CRT湾曲・走査線・VHSトラッキング・ゆらぎ /
  グレイン・ビネット）
- プリセット9種（Y2K / VHS / DREAM / PRINT / PIXEL / SORTED / CINEMA / FILM / NEON）と
  ランダム適用の「おまかせ」
- サムネイル用の文字入れ（フォント3種・色4種・自由配置・ドラッグ移動）
- 2枚目の画像を合成する重ね画像（ブレンド4種）
- 元 / 16:9 / 1:1 / 9:16 の中央クロップ書き出し（画面にガイド表示）

### 素材づくり
- コードで描画するサンプル画像8種（外部素材は不使用）
- AI画像生成（テキスト→画像）。日本語プロンプトは自動で英訳
- AIシーン生成: LLMがシーン仕様(JSON)を設計し、ブラウザがベクター風に描画。
  モチーフ17種（空・太陽・月・星・雲・海・グリッド・山・街・雨・雪・桜・花火・
  オーロラ・鳥居・ネオン看板・鳥）

### 動画
- 最大8カットを並べたショート動画。トランジション4種（フェード / ワイプ /
  ディゾルブ / グリッチワイプ）とKen Burnsズーム
- MP4(H.264)優先で書き出し、そのままリール・ショートに投稿可能
- BGMをAACトラックとして合成し、BPMを自動検出して拍に合わせたカット割り
- 自前実装のGIF89aエンコーダによるGIF書き出し
- カットごとにエフェクトと文字を記憶し、動画中で切り替え
- 編集タブとは別の動画プレビュータブでループ再生

### ギャラリーとナレッジグラフ
- 作品（元画像＋エフェクトレシピ）をR2とD1に保存し、いつでも再編集
- 保存作品をノードにした2D/3Dのフォースグラフ。意味類似（キャプション＋埋め込み）と
  レシピ類似でエッジを自動生成
- 2作品のレシピを交叉した子作品の生成と、系譜エッジによる可視化
- グラフの構造的な穴を検出し、それを埋める作品をLLMが提案する「次の一手」

### 共有
- 全エフェクト設定をURLに埋め込むレシピURL
- 作品ごとの共有ページ（OGP付き、約1日で自動失効）
- OGP画像とXシェア

### プライバシー・費用
- 加工はすべて端末内で完結し、画像は保存操作をしたときのみ送信
- 保存した作品の画像は既定で非公開。期限付き署名URLでのみ閲覧可
- IPごとのレート制限と、無料枠の手前で止まる日次AI予算ガード

### OSSとしての整備
- MITライセンス
- AIプロバイダの抽象化（`workers-ai` / OpenAI互換の `openai` / `none`）。
  Ollama等の自前AIに差し替え可能
- バックエンド無しの静的ホスティングだけでも動く構成（Tier 1）
- 日本語・英語のUIと説明ページ、英語README
- 外部ライブラリ非依存（ピクセルソート・GIFエンコーダ・力学シミュレーションまで自前実装）

---

### English summary

First public release. A browser-based glitch/Y2K image effect studio covering the whole
flow: creating a source image, applying effects, finishing a thumbnail, exporting video,
and organising the results.

- **Effects** — 11 WebGL2 effects (blur, pixel sort, glitch, chromatic aberration,
  halation, color grade, light leak, pixelate, dither/halftone/ASCII, CRT with VHS
  tracking, grain & vignette), 9 presets, thumbnail text, overlay image, ratio crops.
- **Sources** — 8 procedurally drawn samples, AI image generation, and AI *scene*
  generation where an LLM designs a spec and the browser draws flat vector art.
- **Video** — up to 8 cuts with 4 transitions and Ken Burns zoom, MP4 (H.264) export
  ready for Reels/Shorts, music muxed as AAC with automatic BPM-synced cuts, and a
  hand-written GIF89a encoder. Each cut remembers its own effects.
- **Gallery & knowledge graph** — save works with their recipes, browse them as a 2D/3D
  force-directed graph linked by semantic and recipe similarity, crossbreed two works
  into a child, and get LLM suggestions for works that would fill the graph's gaps.
- **Sharing** — recipe URLs, per-work share pages with OGP that expire after about a day.
- **Privacy** — editing never leaves the browser; saved images are private by default and
  served only through expiring signed URLs.
- **Open source** — MIT licensed, no dependencies, swappable AI provider (Workers AI,
  any OpenAI-compatible endpoint, or none), and it runs from static hosting alone.
