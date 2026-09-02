# Changelog

このプロジェクトの主な変更点を記録します。
*Notable changes to this project. English summary follows the Japanese section of each release.*

## [1.2.0] — 2026-09-02

### 追加
- **プロジェクトのクラウド保存**: 素材ごとProject JSONにしてR2へ置き、一覧をD1に持つ。
  ギャラリーと同じアクセスキーで守られ、別端末のブラウザから同じ続きを開ける
  （`PUT/GET/DELETE /api/projects`、1件あたり40MBまで）
- **スタイルバイブル**: 参照画像から代表色を6色拾って、プロジェクト共通のパレットにする。
  新しい色処理「パレット寄せ」が全カットの色をそのパレットへ寄せるので、素材がバラバラでも
  カット間の色が揃う（パレットはレシピではなくプロジェクトに属するので、必ず全カット共通）
- **全カットに統一**: いまのラック設定・seed・パレットを全カットのレシピへ焼き付ける
- AI画像生成にスタイルバイブルのパレットと禁止表現を渡すように（`/api/generate` に
  `style` / `negativePrompt` を追加）
- **カット字幕**: カットごとに1行の字幕を持てるように。プレビューにも重なり、MP4/GIFの
  書き出しに焼き込まれる（縁取り付き・日本語は1文字ずつ折り返して最大2行）
- **AIで字幕を作る**: テーマを1行入れると、カット数と尺に合わせて全カット分の字幕を生成
  （`POST /api/captions`。無音でも伝わること、1カット目をフックにすることを条件に指定）
- **動画クリップの分割**: 選択中の動画クリップをトリム範囲の中央で2カットに分割。
  素材は共有したまま `trim` だけを分けるので、プロジェクトJSONのサイズは増えない
- **動画のレビュー**: MCPの `review_hook_and_pacing` と同じ基準を Web UI からも実行できるように。
  冒頭・尺・緩急・字幕・縦横比を検査し、スコアと指摘を並べる
- **エフェクトの並び替え**: COLOR系9段（ハレーション〜ビネット）の適用順をドラッグで変更
- **Motion Grammarの変形技法**: スタイル変換・形状変形・図形置換をレンダラーで実装

### 修正
- スマホでの当たり判定を実機基準で見直した。iPhone 390pxをエミュレートして測ったところ、
  ボタン・プリセット・つなぎの選択・比率/共有/言語・サイコロが22〜28pxしかなく、
  指で狙うには小さすぎた。タッチ端末では44px（`.cloud-item` などは40px）を下限にし、
  About/GitHubリンクとチェックボックスのラベルもタップ領域を44pxに広げた
- スライダーがつまみの分だけ親要素から4pxはみ出していたのを内側へ収めた

### ツール
- CLIレンダラー（`scripts/noizlab-effect.mjs`）に `--caption` / `--palette` /
  `--palette-mix` / `--gif` を追加。カットごとの字幕とスタイルバイブルを効かせた
  動画・GIFをコマンドから作れる（READMEのデモ素材はこれで生成している）

### ドキュメント素材
- `docs/demo.gif` を字幕入りの4カット動画へ差し替え
- `docs/style-bible.png`（パレット寄せの有無を並べた比較）と
  `docs/ui.png`（スタイルバイブルと動画パネル）を追加し、両READMEへ掲載

### テスト
- `scripts/test-web-app.mjs` を追加。public/ を複製して検証コードを足し、headless Chromeで
  実際に描画させた結果を検査する18項目の回帰テスト。配列uniformがシェーダへ届かない、
  module冒頭のTDZで以降が実行されない、Project JSONの往復で編集内容が落ちる、
  字幕が焼き込まれない、といったコードを読むだけでは気づけない壊れ方を捕まえる
  （Chromeが無い環境ではスキップ。`CHROME_BIN` で場所を指定できる）

### ドキュメント
- [TikTok投稿の手順](docs/tiktok-posting.md)を追加。開発者アプリの登録から
  OAuth・下書き保存・直接投稿までの段取りと、NOIZ LAB側に足すルート・テーブル・
  シークレット、規約上守ることをまとめた（実装は未着手）

### 変更
- MCPの `apply_style_bible` が書く `{preset, palette, seed}` 形式のレシピを、Web版が
  読める形へ解決するように（これまでは既定値で描画していた）
- 判定ロジック `reviewProject()` を `public/project-format.js` へ移し、ブラウザとMCPで共有
- Project JSONの `captions` を編集画面の状態から生成し、読み込み時にカットへ戻すように
- 同じ素材を複数カットが参照する場合、`assets` を重複排除するように

---

### English summary

- **Per-cut captions**: each cut can carry a one-line caption. It shows in the preview and is
  burned into MP4 / GIF exports, outlined, wrapped character by character for Japanese.
- **AI captions**: type a one-line theme and get a caption for every cut, sized to its duration
  (`POST /api/captions`). The model is told they must work with the sound off and that cut 1 is the hook.
- **Clip splitting**: split the selected video clip in half. Both halves share one asset and differ
  only by `trim`, so the project JSON does not grow.
- **Video review**: the Web UI can now run the same checks as the MCP `review_hook_and_pacing`
  (opening, length, pacing, captions, aspect ratio) and lists the findings with a score.
- **Effect reordering**: drag to reorder the nine colour stages, halation through vignette.
- **Cloud projects**: a project, assets and all, is stored in R2 with its listing in D1, behind the
  same access key as the gallery, so another browser can pick up where you left off
  (`PUT/GET/DELETE /api/projects`, 40MB per project).
- **Style bible**: pick six representative colors from a reference image and keep them at the
  project level. A new colour stage, palette lock, pulls every cut toward that palette, so cuts
  from different sources share one colour identity. AI image generation gets the same palette
  and avoid-list.
- Touch targets reworked against an emulated 390px phone: buttons, preset chips, the transition
  picker, the ratio/share/language row and the dice buttons were 22–28px tall. On touch devices
  they are now at least 44px, and the About/GitHub links and checkbox labels get a 44px tap area.
- CLI renderer gains `--caption`, `--palette`, `--palette-mix` and `--gif`, so captioned,
  palette-locked videos and GIFs can be produced from the command line. The README demo
  assets are generated with it.
- Refreshed the README figures: a captioned four-cut demo GIF, a palette-lock before/after
  comparison, and a shot of the style bible and video panels.
- Added `scripts/test-web-app.mjs`: 18 regression checks that render the real app in headless
  Chrome, covering array uniforms reaching the shader, module initialisation, Project JSON
  round-trips and caption burn-in. Skipped when no Chrome is found.
- Added [a walkthrough for TikTok posting](docs/tiktok-posting.md): developer-app registration,
  OAuth, draft upload and direct post, plus the routes, table and secrets NOIZ LAB would need.
  Not implemented yet.
- MCP `apply_style_bible` recipes (`{preset, palette, seed}`) now resolve into real settings in the web app.
- **Motion Grammar transformation techniques**: style transformation, shape morph and graphic substitution.

## [1.1.1] — 2026-09-02

### 変更
- 文字入れの書体を3種から**8種**に拡張（極太・明朝・丸ゴ・ポップ・レゲエを追加）
- シェア時に黙ってフォールバックしていた挙動をやめ、いま何が起きているかを表示するように
- AI生成した画像は、ギャラリーのアクセスキーが無くても**画像付きの共有リンク**で投稿できるように

### 修正
- 英語UIに日本語が残っていた27件を翻訳（動画クリップのトリム、トランジション4種、
  かんたん動画の3ステップ、`file://` で開いたときの警告、Project JSON関連のメッセージ）
- `aria-label` も翻訳対象に追加

---

### English summary

- Thumbnail text now offers **8 typefaces** (heavy, mincho, rounded, pop and reggae added).
- Sharing no longer falls back silently; it reports what it is doing.
- AI-generated images can be shared with an image card even without a gallery access key.
- Fixed 27 strings that stayed Japanese in the English UI (clip trimming, four transitions,
  the three-step video guide, the `file://` warning, Project JSON messages), and
  `aria-label` is now translated as well.

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
