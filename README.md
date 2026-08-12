# NOIZ LAB — 画像エフェクト実験室

ブラウザ内 (WebGL2) で完結する、Y2K / グリッチ系の画像エフェクトWebアプリ。
Cloudflare Workers (静的アセット + Workers AI) でホスティングしています。

**URL**: https://image-effector.pregum-dev.workers.dev

![demo](docs/demo.gif)

## 概要

SNSで流行しているグリッチ加工・ピクセルソート・ディザ/ハーフトーン・CRT/VHS風加工などを、
ブラウザだけでリアルタイムに適用・保存できる実験室。エフェクトは機材ラック風のUI（EFFECT RACK）で
個別にON/OFF・パラメータ調整でき、プリセットからワンタップで雰囲気を作れます。

- 画像処理はすべてクライアント側 (WebGL2 シェーダー + Canvas) で完結し、画像はサーバーへ送信されない
- 元画像がなくても Workers AI (FLUX.1 schnell) でテキストから生成してそのまま加工できる

## 機能

| カテゴリ | 内容 |
|---|---|
| エフェクト | ぼかし / ピクセルソート / グリッチ / RGBずらし(色収差) / ハレーション / モザイク / ベイヤーディザ・ハーフトーン / CRT湾曲・走査線 / グレイン・ビネット |
| プリセット | Y2K / VHS / DREAM / PRINT / PIXEL / SORTED + おまかせ(ランダム) |
| AI生成 | Workers AI (FLUX.1 schnell)。日本語プロンプトは llama-3.1-8b で英訳してから生成 |
| 入出力 | ドラッグ&ドロップ / ファイル選択 / クリップボード貼り付け読み込み、PNG保存 |
| 保護 | AI生成APIはIPごと5回/分のレート制限 (Durable Objects)、無料枠超過時は503で案内 |

## 構成

```
public/          静的アセット (index.html / style.css / app.js)
  app.js         WebGL2パイプライン・エフェクトラックUI・ピクセルソート(CPU)
src/worker.js    /api/generate (Workers AI) + レート制限DO + アセット配信
wrangler.jsonc   Workers設定 (AI / Durable Objects / assets バインディング)
docs/demo.gif    デモ
```

レンダリングは「元画像(＋CPUピクセルソート) → 分離ガウシアンブラー → 輝度抽出+ブラー(ハレーション) →
最終合成シェーダー(グリッチ/色収差/ディザ/CRT/グレイン)」のマルチパス構成。

## 開発・デプロイ

```sh
npx wrangler dev      # ローカル開発 (http://localhost:8787)
npx wrangler deploy   # デプロイ (pregum.dev アカウントにログインしていること)
```

## ロードマップ

### 近いうち
- [ ] OGP画像・シェア導線（加工結果をXへシェアしやすく）
- [ ] エフェクト設定のURL共有（クエリパラメータにシリアライズして再現可能に）
- [ ] エフェクト追加: ASCIIアート化 / VHSトラッキングノイズ / 走査線ゆらぎ / LUTカラーグレーディング
- [ ] モバイルUIの調整（ラックのタッチ操作性）

### そのうち
- [ ] GIF / WebM書き出し（WebCodecsでアニメーショングリッチをそのまま動画に）
- [ ] エフェクトの並び替え（ラックの順序をドラッグで入れ替えて適用順を変更）
- [ ] AI img2img（手持ち画像をAIでスタイル変換してから加工）
- [ ] PWA対応（オフラインでもエフェクトのみ利用可能に）

### 検討中
- [ ] Turnstile導入（AI生成APIのbot対策強化）
- [ ] プリセットのユーザー保存・共有ギャラリー
- [ ] 独自ドメイン化
