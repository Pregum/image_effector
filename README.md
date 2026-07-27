# NOIZ LAB — 画像エフェクト実験室

ブラウザ内 (WebGL2) で完結する画像エフェクトWebアプリ。
Cloudflare Workers (静的アセット + Workers AI) でホスティング。

**URL**: https://image-effector.pregum.workers.dev

## 機能

- **エフェクトラック**: ぼかし / ピクセルソート / グリッチ / RGBずらし(色収差) / ハレーション / モザイク / ディザ(ベイヤー)・ハーフトーン / CRT・走査線 / グレイン・ビネット
- **プリセット**: Y2K, VHS, DREAM, PRINT, PIXEL, SORTED
- **AI画像生成**: Workers AI (FLUX.1 schnell)。日本語プロンプトは llama-3.1-8b で英訳してから生成
- 画像はドラッグ&ドロップ / ファイル選択 / クリップボード貼り付けで読み込み、PNG保存可能
- AI生成以外の画像処理はすべてクライアント側で完結（画像はサーバーへ送信されない）

## 構成

```
public/          静的アセット (index.html / style.css / app.js)
src/worker.js    /api/generate (Workers AI) + アセット配信
wrangler.jsonc   Workers 設定 (AIバインディング含む)
```

## 開発・デプロイ

```sh
npx wrangler dev      # ローカル開発 (http://localhost:8787)
npx wrangler deploy   # デプロイ
```
