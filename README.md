# NOIZ LAB — 画像エフェクト実験室

ブラウザだけで動く、Y2K / グリッチ系の画像エフェクトツール。
写真やイラストにエフェクトをかけ、サムネイルやリール用の縦動画まで書き出せます。

*A browser-based glitch/Y2K image effect studio. All image processing runs in WebGL2 on the client; the optional backend is a single Cloudflare Worker. No dependencies, MIT licensed.*

**作者のインスタンス**: https://image-effector.pregum-dev.workers.dev
（[説明ページ](https://image-effector.pregum-dev.workers.dev/about)）

![demo](docs/demo.gif)

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
| ショート動画 | 最大8カット + トランジション4種 + Ken Burnsズーム。9:16等のクロップ・長辺1280px・MP4(H.264)優先。カットごとにエフェクトを記憶 |
| BGM・BPM同期 | 音声をAACトラックとして合成。読み込み時にBPMを自動検出し拍に合わせたカット割りに |
| GIF書き出し | 自前のGIF89aエンコーダ（メディアンカット+ディザ+LZW） |
| ギャラリー | 作品（元画像+レシピ）をR2+D1に保存。**画像は既定で非公開**（期限付き署名URLでのみ閲覧可） |
| 共有リンク | 作品ごとに `/w/<id>` を発行。OGP付きで、**約1日で自動失効** |
| ナレッジグラフ | 保存作品をノードにした2D/3Dフォースグラフ。キャプション+埋め込みの意味類似とレシピ類似でエッジを生成 |
| 掛け合わせ | 2作品のレシピを交叉した子作品を生成。系譜エッジで可視化 |
| 次の一手 | グラフの構造的な穴を検出し、それを埋める作品をLLMが提案。その場で生成できる |
| 保護 | IPごとのレート制限 (Durable Objects) と日次AI予算ガード |
| PWA | manifest + Service Worker（ネットワーク優先） |

## 構成

```
public/          静的アセット（これだけでTier 1として動く）
  app.js         WebGL2パイプライン・UI・ピクセルソート・GIFエンコーダ・グラフ
  about.html     サイトの説明ページ
src/
  worker.js      APIルーティング・ギャラリー・共有・レート制限
  ai.js          AIプロバイダの抽象化（workers-ai / openai / none）
schema.sql       D1スキーマ
wrangler.jsonc   Workers設定（fork時は name / database_id / bucket_name を変更）
```

レンダリングは「元画像(＋CPUピクセルソート) → 分離ガウシアンブラー → 輝度抽出+ブラー(ハレーション)
→ 最終合成シェーダー(グリッチ/色収差/ディザ/グレード/CRT/文字/グレイン)」のマルチパス構成です。

**外部ライブラリを使っていません。** フォースグラフの力学シミュレーション、GIFのLZW圧縮と減色、
ピクセルソート、全エフェクトのシェーダーはすべて自前実装です（`package.json` もありません）。

## 開発

```sh
npx wrangler dev      # ローカル（localhost のAIエンドポイントにも到達できる）
npx wrangler deploy   # デプロイ
```

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

## ロードマップ

- [x] エフェクト・プリセット・サンプル画像
- [x] AI生成（写真 / シーン）
- [x] サムネ文字入れ・クロップ書き出し・OGP・レシピURL共有
- [x] ショート動画（MP4 / GIF、BGM・BPM同期、カットごとのエフェクト）
- [x] ギャラリー → 類似グラフ → 掛け合わせ → 穴からの提案
- [x] 画像の非公開化と期限付き共有リンク
- [x] AIプロバイダの差し替え・バックエンド無し構成
- [ ] エフェクトの並び替え（現在は適用順が固定。COLOR GRADEのみ前後を切替可）
- [ ] AI img2img（無料枠で動くモデルが見つからず保留）
