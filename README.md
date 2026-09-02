# NOIZ LAB — 画像エフェクト実験室

ブラウザだけで動く、Y2K / グリッチ系の画像エフェクトツール。
写真やイラストにエフェクトをかけ、サムネイルやリール用の縦動画まで書き出せます。

**[English README](README.en.md)** — *A browser-based glitch/Y2K image effect studio. All image processing runs in WebGL2 on the client; the optional backend is a single Cloudflare Worker. No dependencies, MIT licensed.*

**作者のインスタンス**: https://image-effector.pregum-dev.workers.dev
（[説明ページ](https://image-effector.pregum-dev.workers.dev/about)）

![demo](docs/demo.gif)

## プロダクトコンセプト

NOIZ LABが目指すのは、**素材を入れて雰囲気を選ぶだけで、SNSへ出せる動画が完成する、より簡単な動画編集ツール**です。
編集に詳しくない人でも「新しいアプリを15秒で紹介したい」「夏の終わりのVHS風にしたい」のように目的を伝えれば、企画から書き出しまで進められる体験を目指します。

基本の導線は3ステップです。

1. 画像・動画・画面録画を追加する
2. ムード、テンポ、見せ方を選ぶ
3. 9:16などの投稿形式でプレビューして保存する

素材がない場合は、AIが絵コンテを作り、不足する画像を生成します。まずはAI画像にパン、ズーム、パララックス、フィルムバーンなどを加えた軽量な「疑似動画」を組み立て、必要なカットだけ将来の動画生成モデルへ差し替えられる設計にします。

### AIおまかせ制作（構想中）

```text
目的・雰囲気を入力
  → ターゲット、尺、冒頭のフックを整理
  → 絵コンテJSONを生成
  → 不足素材をAIで生成
  → 自動でタイムラインへ配置
  → 字幕、BPM、エフェクト、トランジションを調整
  → 読みやすさとテンポを確認
  → MP4を書き出し／投稿
```

生成カット間の統一感を保つため、プロジェクトごとに「スタイルバイブル」を持たせる予定です。主役・商品、参照画像、色、時間帯、照明、画角、質感、字幕、seed、使用禁止表現を共有し、すべての生成と再編集で同じ設定を使います。

「バズる」こと自体は保証できませんが、冒頭で内容が伝わるか、無音でも理解できるか、字幕が読めるか、尺とカット間隔が目的に合うか、といった確認を自動化して完成度を底上げします。

演出は「なんか派手に」という曖昧な指定ではなく、コマ打ち、ポーズ置換、図形置換、形状変形、シルエット接続、マッチカット、時間差、グリッド運動、残像、版ズレ、網点、コラージュなどの**モーション文法**として理解・選択・合成します。役割、パラメータ、組み合わせ方、Storyboard JSON例は[NOIZ LAB Motion Grammar](docs/motion-grammar.md)を参照してください。

### MCP／エージェント連携

Claude CodeなどのMCPクライアントから、企画・編集・確認・書き出しを操作できます。
依存パッケージは無く、`node mcp/server.mjs` だけで動きます。

```jsonc
// Claude Codeなら: claude mcp add noiz-lab -- node /path/to/image_effector/mcp/server.mjs
{
  "mcpServers": {
    "noiz-lab": { "command": "node", "args": ["/path/to/image_effector/mcp/server.mjs"] }
  }
}
```

| MCPツール | 役割 |
|---|---|
| `create_project_from_brief` | 目的・対象視聴者・尺・投稿先からプロジェクトと構成案を作成 |
| `generate_storyboard` | フック・展開・締めを含む絵コンテを生成 |
| `generate_missing_assets` | 絵コンテのカットに対応する画像をWorkers AIで生成 |
| `apply_style_bible` | 色・照明・画角・プリセットを全カットへ統一適用 |
| `build_short_video` | 素材をタイムラインへ並べ、BPMとトランジションを設定 |
| `review_hook_and_pacing` | 冒頭・テンポ・尺・字幕・縦横比を検査し、指摘とスコアを返す |
| `render_project` | タイムラインをMP4へ書き出す（ヘッドレスChromeとffmpegが必要） |
| `read_project` / `write_project` | Project JSONの読み書き。Web版とそのまま行き来できる |
| `validate_project` | 共通スキーマに沿っているか検証 |

`generate_storyboard` には2つの経路があります。MCPクライアント自身がLLMなので、
**絵コンテを自分で書いて `storyboard` に渡せばバックエンドは不要**です。
デプロイ済みインスタンスの `endpoint` を渡すと、サーバー側のLLM（`/api/storyboard`）が書きます。
絵コンテは役割・尺・画の指示・字幕・画像生成プロンプト・演出・つなぎを持ち、
`build_short_video` へ渡すとカットごとの緩急がそのままタイムラインに反映されます。

`generate_missing_assets` は絵コンテの `imagePrompt` から不足カットの画像を生成します。
Workers AIを使うため `endpoint`（Tier 2以上のデプロイ先）が必要です。
スタイルバイブルの作風・配色・照明を全プロンプトへ同じ文言で足すので、
別々に生成したカットでも見た目が揃います。1回につき最大8枚。
一部が失敗しても成功分は返るので、足りないカットだけ再実行できます。

素材とレンダリング処理はアプリ側（`scripts/noizlab-variety-video.mjs`）が持ち、MCPは操作の入口に徹します。
各ツールは戻り値の `project` をそのまま次のツールへ渡す形で連結します。

```text
create_project_from_brief → generate_storyboard → generate_missing_assets
  → apply_style_bible → build_short_video → review_hook_and_pacing → render_project
```

### Web版との行き来

`write_project` は既定でローカル素材をJSONへ埋め込みます。Web版の「↑ JSONを開く」で
そのまま開けるので、**MCPで企画・生成 → ブラウザで手直し**という往復ができます。
素材はファイルパス参照のままだとブラウザから読めないため、この埋め込みが必要です
（合計150MBまで。`embedAssets: false` で参照のままにもできますが、Web版では開けません）。

逆向きも同じです。Web版が書き出した `.noiz.json` は素材が埋め込まれているので、
`read_project` に `extractAssetsTo` を渡してファイルへ展開すると `render_project` へ渡せます。
`render_project` は埋め込み素材を自動で展開するため、ブラウザで作ったプロジェクトを
そのまま書き出すこともできます。

`export_for_tiktok`（投稿API）は未実装です。
`render_project` が扱えるのは `source.kind` が `local` か `embedded` の素材で、
1本あたり最大8カット、1カットの保持時間は0.3〜3秒です。

## 作例（AIシーン生成）

日本語プロンプト → LLMがシーン仕様(JSON)を設計 → Canvasがベクター風に描画。

![scenes](docs/scenes.gif)

| 「桜舞う神社の参道、夕暮れ」 | 「夏祭りの夜、湖の上に上がる花火」 |
|---|---|
| ![sakura](docs/scene-sakura.png) | ![fireworks](docs/scene-fireworks.png) |
| **「雨のネオン街、看板は『深夜』と『ラーメン』」** | **「オーロラの下の雪原と山」** |
| ![neon](docs/scene-neon.png) | ![aurora](docs/scene-aurora.png) |

---

## 3つの構成から選べます

必要な機能だけ有効にできます。使えない機能のUIは自動的に隠れるので、
どの構成でもそのまま動きます。

| | 必要なもの | 使える機能 |
|---|---|---|
| **Tier 1**<br>静的ホスティング | 何もいらない<br>（GitHub Pages等でも可） | エフェクト・サンプル画像・文字入れ・重ね画像・動画(MP4/GIF)・書き出し |
| **Tier 2**<br>Cloudflare | Workers + Workers AI<br>+ D1 + R2 + Durable Objects | ＋ AI画像生成・AIシーン生成・ギャラリー・ナレッジグラフ・共有リンク |
| **Tier 3**<br>自前AI | Tier 2 の構成で<br>AIだけ差し替え | ＋ OpenAI互換エンドポイント（Ollama等）を利用 |

### Tier 1: とりあえず動かす

```sh
git clone https://github.com/<you>/image_effector.git
cd image_effector/public
python3 -m http.server 8000   # → http://localhost:8000
```

`public/` を配るだけなので、GitHub Pages や Netlify にそのまま置けます。
バックエンドが無い場合は `/api/config` の取得に失敗し、AI・ギャラリーのUIは自動的に隠れます。

### Tier 2: Cloudflareにデプロイ

```sh
# 1. リソースを作る（出力される database_id を控える）
npx wrangler d1 create noiz-lab
npx wrangler r2 bucket create noiz-lab-works

# 2. wrangler.jsonc の name / database_id / bucket_name を自分のものに書き換える

# 3. スキーマを適用
npx wrangler d1 execute noiz-lab --remote --file schema.sql

# 4. ギャラリーのアクセスキーを設定（任意の長い文字列）
npx wrangler secret put GALLERY_KEY

# 5. デプロイ
npx wrangler deploy
```

`GALLERY_KEY` を設定しなければギャラリー機能は無効のまま、AI機能だけ使えます。

### Tier 3: AIを自前のものに差し替える

AIの利用は4種類（テキスト生成 / テキスト→画像 / 画像→テキスト / 埋め込み）だけで、
これはOpenAI互換APIの標準カテゴリと一致します。環境変数で切り替えられます。

```sh
# .dev.vars（ローカル）または wrangler secret put（本番）
AI_PROVIDER=openai
AI_BASE_URL=http://localhost:11434/v1   # Ollama の例
AI_API_KEY=ollama
AI_MODEL_CHAT=llama3.3
AI_MODEL_VISION=llava
AI_MODEL_EMBED=bge-m3
```

> **注意**: Cloudflare Workersはエッジで動くため `localhost` には到達できません。
> ローカルのAIを使う場合は `npx wrangler dev` で起動するか、
> Cloudflare Tunnel などでエンドポイントを公開してください。
>
> 動作を実地で確認しているのは `workers-ai` プロバイダのみです。
> `openai` プロバイダは仕様に沿った実装ですが、各実装（Ollama / LM Studio / vLLM 等）
> ごとの差異までは検証していません。

## 設定

| 変数 | 既定 | 説明 |
|---|---|---|
| `GALLERY_KEY` | なし | ギャラリーのアクセスキー。未設定ならギャラリー機能は無効 |
| `AI_PROVIDER` | `workers-ai` | `workers-ai` / `openai` / `none` |
| `AI_BASE_URL` | OpenAI本家 | `openai` 時のエンドポイント |
| `AI_API_KEY` | なし | `openai` 時のキー（ローカルAIなら不要な場合が多い） |
| `AI_MODEL_CHAT` ほか | プロバイダ既定 | 使用モデル名（`_CHAT_SMALL` / `_IMAGE` / `_VISION` / `_EMBED`） |
| `AI_DAILY_CAP` | `8000` | 1日あたりのAI予算。超えると503を返して止まる |
| `WEB_ANALYTICS_TOKEN` | なし | Cloudflare Web Analyticsのトークン。設定時だけビーコンを読み込む |
| `GA_MEASUREMENT_ID` | なし | GA4の測定ID。設定時だけgtagを読み込む |
| `PLAUSIBLE_DOMAIN` / `PLAUSIBLE_SRC` | なし | Plausible等に登録したドメインとスクリプトURL |

`.dev.vars.example` をコピーして `.dev.vars` を作ってください。

## 機能

| カテゴリ | 内容 |
|---|---|
| エフェクト | ぼかし / ピクセルソート / グリッチ / RGBずらし(色収差) / ハレーション / 色調エモ化 / 光漏れ / モザイク / ベイヤーディザ・ハーフトーン・アスキーアート / CRT湾曲・走査線・VHSトラッキング・ゆらぎ / グレイン・ビネット |
| プリセット | Y2K / VHS / DREAM / PRINT / PIXEL / SORTED / CINEMA / FILM / NEON + おまかせ。`/#preset=CINEMA` で直リンク可 |
| AI生成（写真） | テキスト→画像。日本語プロンプトはLLMで英訳してから生成 |
| AI生成（シーン） | LLMがシーン仕様(JSON)を設計し、ブラウザがCanvasでベクター風に描画。モチーフ: 空/太陽/月/星/雲/海/グリッド/山/街/雨/雪/桜/花火/オーロラ/鳥居/ネオン看板/鳥 |
| 文字入れ | サムネ用タイトル文字（フォント3種・色4種・自由配置・ドラッグ移動）。グリッチの影響を受けず、CRT・粒子には馴染む合成 |
| 重ね画像 | 2枚目の画像をソース段階で合成。合成後の全体にエフェクトがかかる |
| ショート動画 | 画像・動画を最大8カット。動画トリム + オリジナルトランジション8種（＋Project JSON経由で接続技法4種） + Ken Burnsズーム。9:16等のクロップ・長辺1280px・MP4(H.264)優先。カットごとにエフェクトを記憶 |
| BGM・BPM同期 | 音声をAACトラックとして合成。読み込み時にBPMを自動検出し拍に合わせたカット割りに |
| プロジェクト保存 | 素材Blobと編集内容をブラウザのIndexedDBに保存し、「前回の続き」から再編集。サーバー送信なし |
| Project JSON | バージョン付き共通スキーマで素材・タイムライン・レシピ・Motion・BGM・レンダー設定を保存。素材埋め込みJSONの入出力に対応 |
| GIF書き出し | 自前のGIF89aエンコーダ（メディアンカット+ディザ+LZW） |
| ギャラリー | 作品（元画像+レシピ）をR2+D1に保存。**画像は既定で非公開**（期限付き署名URLでのみ閲覧可） |
| 共有リンク | 作品ごとに `/w/<id>` を発行。OGPに**加工後の画像そのもの**が出る（長辺1200pxのJPEG）。**約1日で自動失効** |
| Xでシェア | ギャラリーがある構成では、共有リンクを作ってから投稿するのでカードに画像が出る。**AI生成した画像はアクセスキー無しでも**（生成直後の絵を約1日だけ置いて）画像付きで共有できる。バックエンドが無い構成ではレシピURLを投稿 |
| ナレッジグラフ | 保存作品をノードにした2D/3Dフォースグラフ。キャプション+埋め込みの意味類似とレシピ類似でエッジを生成 |
| 掛け合わせ | 2作品のレシピを交叉した子作品を生成。系譜エッジで可視化 |
| 次の一手 | グラフの構造的な穴を検出し、それを埋める作品をLLMが提案。その場で生成できる |
| 保護 | IPごとのレート制限 (Durable Objects) と日次AI予算ガード |
| 多言語 | 日本語・英語のUI。自動判定＋切替ボタン。`/#lang=en` で直リンク可 |
| 利用状況の計測 | 機能ごとの利用回数をAnalytics Engineへ。Cookie・訪問者IDなし。未設定なら完全に無効（[詳細](#利用状況の計測)） |
| PWA | manifest + Service Worker（ネットワーク優先） |

## 構成

```
public/          静的アセット（これだけでTier 1として動く）
  app.js         WebGL2パイプライン・UI・ピクセルソート・GIFエンコーダ・グラフ
  project-format.js 共通Project JSONの生成・検証・読み込み
  i18n.js        日本語・英語の文言
  analytics.js   利用イベントの送信（送信先が無ければ何もしない）
  about.html     サイトの説明ページ（英語版は about-en.html）
src/
  worker.js      APIルーティング・ギャラリー・共有・レート制限
  ai.js          AIプロバイダの抽象化（workers-ai / openai / none）
schema.sql       D1スキーマ
schemas/         Web / Desktop / Mobile / MCPで共有するJSON Schema
mcp/
  server.mjs     MCPサーバー（stdio / JSON-RPC、依存パッケージ無し）
  tools.mjs      Project JSONを組み立てるツール本体
wrangler.jsonc   Workers設定（fork時は name / database_id / bucket_name を変更）
```

レンダリングは「元画像(＋CPUピクセルソート) → 分離ガウシアンブラー → 輝度抽出+ブラー(ハレーション)
→ 最終合成シェーダー(グリッチ/色収差/ディザ/グレード/CRT/文字/グレイン)」のマルチパス構成です。

**外部ライブラリを使っていません。** フォースグラフの力学シミュレーション、GIFのLZW圧縮と減色、
ピクセルソート、全エフェクトのシェーダーはすべて自前実装です（`package.json` もありません）。

## 利用状況の計測

「どの機能に需要があるか」を知るためだけの仕組みです。3つとも**任意**で、
何も設定しなければ計測用のコードは1バイトも配信されません（forkした人の計測先が
作者になることはありません）。

| 何を | どこで見る | 有効化 |
|---|---|---|
| ページビュー・リファラ・国・Core Web Vitals | Cloudflare Web Analytics | `WEB_ANALYTICS_TOKEN` |
| 機能ごとの利用回数 | Workers Analytics Engine | `wrangler.jsonc` の `analytics_engine_datasets` |
| （任意）外部SaaS | GA4 / Plausible | `GA_MEASUREMENT_ID` / `PLAUSIBLE_DOMAIN` |

記録するイベントは次のとおりです。クライアント発のイベント名は
`src/worker.js` の `CLIENT_EVENTS` で許可リスト化されており、それ以外は捨てられます。

| イベント | ラベル | 意味 |
|---|---|---|
| `app_open` | 言語 | エディタが実際に起動した |
| `effect_on` | エフェクトID | エフェクトをONにした |
| `preset` | プリセット名 | プリセットを選んだ（初期表示は数えない） |
| `random` / `sample` / `open_image` | — | おまかせ / サンプル切替 / 自分の画像を開いた |
| `export` | `png` `mp4` `webm` `gif` | 書き出した |
| `share` | `image` `url` | Xでシェアした（画像つき共有リンクか、レシピURLか） |
| `ai_image` / `ai_scene` / `ai_suggest` | `ok` / HTTPステータス | AI機能の呼び出しと成否 |
| `work_save` / `work_share` | 同上 | ギャラリー保存 / 共有リンク発行 |
| `share_view` | `ok` / `expired` | 共有ページが開かれた（キャッシュ分は数えないので下限値） |

**記録しないもの**: IP・User-Agent・Cookie・訪問者ID・画像・プロンプト本文・レシピの中身。
地域は国コードまでに丸めています。

集計はAnalytics EngineのSQL APIで行えます。

```sh
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d "SELECT blob1 AS event, blob2 AS label, sum(_sample_interval) AS n
      FROM noiz_lab_events
      WHERE timestamp > now() - INTERVAL '7' DAY
      GROUP BY event, label ORDER BY n DESC"
```

## 開発

```sh
npx wrangler dev      # ローカル（localhost のAIエンドポイントにも到達できる）
npx wrangler deploy   # デプロイ

node scripts/test-project-format.mjs   # Project JSONの往復テスト
node scripts/test-mcp-server.mjs       # MCPツールとstdio越しのJSON-RPC
```

### Codex / Claude Code から画像を加工

Node.js 22以降とChrome（またはChromium）があれば、npm installなしで既存のWebGL処理をCLIから呼び出せます。

```sh
node scripts/noizlab-effect.mjs input.jpg output.png --preset CINEMA
node scripts/noizlab-effect.mjs input.jpg output.png --preset FILM --ratio 9:16 --text '夏の終わり|1999'
node scripts/noizlab-effect.mjs --video 1.png 2.png 3.png ending.mp4 \
  --preset FILM --ratio 16:9 --transition film-burn --hold 1.4 --duration 0.8
node scripts/noizlab-variety-video.mjs ending.mp4 \
  1.jpg@FILM 2.jpg@DREAM 3.jpg@NEON 4.jpg@CINEMA \
  --transitions film-burn,flash,push

# macOSアプリの対象ウィンドウだけをデモ録画（macOS 15+）
swiftc -parse-as-library scripts/record-macos-window.swift -o /tmp/noiz-record-window
/tmp/noiz-record-window Pane pane-demo.mp4 12
```

利用可能なプリセットは `--list-presets`、全オプションは `--help` で確認できます。
トランジションは `fade`、`wipe`、`dissolve`、`glitch`、`punch`、`flash`、`push`、`film-burn` から選択できます。実装・名称・UIはNOIZ LAB独自のものです。
Web版の「＋ 画像・動画」ではMP4等を素材として追加し、開始・終了位置を0.1秒単位でトリムできます。動画クリップを含む場合はMP4で書き出してください。現バージョンでは素材動画の音声は含めず、選択したBGMを使用します。
Codex用のスキルは `.agents/skills/noiz-lab-effects/`、Claude Code用は
`.claude/skills/noiz-lab-effects/` に同梱しています。「この画像をエモくして」のように指示すると、
雰囲気に合うプリセットを選んでPNGを書き出します。

## お金について

作者のインスタンスはCloudflareの無料枠内で動いています。無料枠を超えたAPIは
エラーを返して停止するだけで請求は発生しません。加えて、Workers AIの無料枠
(10,000ニューロン/日) の80%で自分から止まる予算ガードを入れてあります。

ただしこれは**Workers Freeプランでの話**です。有料プランや、外部のAI API
（OpenAI等）を `AI_PROVIDER=openai` で指定した場合は、当然ながらその課金体系に従います。

## ライセンスと権利

MIT License（[LICENSE](LICENSE)）。

- サンプル画像・シーン生成の絵はすべてコードで描画しており、外部素材は使っていません
- フォントはGoogle Fonts (SIL Open Font License) をCDNから読み込んでいます
- 利用するAIモデルのライセンスは、選んだプロバイダのものに従います

## 変更履歴

[CHANGELOG.md](CHANGELOG.md) を参照してください。

## ロードマップ

- [x] エフェクト・プリセット・サンプル画像
- [x] AI生成（写真 / シーン）
- [x] サムネ文字入れ・クロップ書き出し・OGP・レシピURL共有
- [x] ショート動画（MP4 / GIF、BGM・BPM同期、カットごとのエフェクト）
- [x] 動画クリップの読み込み・簡易トリム・ローカルプロジェクト保存
- [x] ギャラリー → 類似グラフ → 掛け合わせ → 穴からの提案
- [x] 画像の非公開化と期限付き共有リンク
- [x] AIプロバイダの差し替え・バックエンド無し構成
- [x] 企画入力 → 絵コンテJSON → 不足素材生成 → 自動タイムライン
- [x] スタイルバイブルと参照素材によるカット間の一貫性維持（参照画像→パレット→全カットへ適用）
- [x] Motion Grammarのカメラ系5技法をレンダラーで実装（他は技法名を保持してフォールバック）
- [x] Motion Grammarの表面表現（網点・版ズレ）をカメラの動きへ重ねる
- [x] Motion Grammarの接続技法（マスク展開・放射ワイプ・シルエット接続・マッチカット）
- [x] Motion Grammarの変形技法（形状変形、図形置換、スタイル変換）
- [x] 字幕生成、分割、カット別トランジション、フック／テンポの自動レビュー
- [x] 共通Project JSONと素材埋め込み入出力
- [x] MCPとWeb版のプロジェクト往復（素材埋め込みJSON経由）
- [x] プロジェクトのクラウド保存（R2＋D1。別端末のブラウザから同じ続きを開ける）
- [ ] デスクトップ／モバイルのネイティブアプリ（現状はブラウザのみ）
- [x] MCPサーバーから企画・編集・レビュー・書き出しを操作
- [x] MCPからのAI絵コンテ生成（自前で書く／サーバーのLLMに書かせる）
- [x] MCPからの不足素材のAI生成
- [ ] TikTok Content Posting APIを使った下書き／直接投稿
  （TikTok側で開発者アプリの登録と審査、利用者のOAuth連携が必要なため未着手。
  段取りは[TikTok投稿の手順](docs/tiktok-posting.md)にまとめてあります）
- [x] エフェクトの並び替え（COLOR系9段の適用順をドラッグで入れ替え）
- [ ] AI img2img（無料枠で動くモデルが見つからず保留）
