# コントリビュートについて / Contributing

ありがとうございます。Issue も Pull Request も歓迎します。
日本語・英語どちらでも構いません。 *Japanese or English, either is fine.*

## このリポジトリの決めごと

**依存パッケージを増やさない。** `package.json` はありません。画像処理・GIFエンコーダ・
グラフのレイアウトまで、すべて自前で書いてブラウザの標準APIだけで動かしています。
ビルド手順が無いこと自体が、このプロジェクトの取り回しの良さです。
新しいライブラリが必要に見えたら、まず Issue で相談してください。

**無料枠と法の範囲で動かす。** 作者のインスタンスは Cloudflare の無料枠で動いています。
課金が発生するモデルやサービスは採用しません。生成物のライセンスも、商用利用できるものだけを
使っています（画像生成は Apache 2.0 の FLUX.1 schnell、フォントはすべて OFL）。

**日本語がUIの原文。** `public/i18n.js` は「日本語の文字列そのもの」を辞書のキーにしています。
UIに文字を足したら、同じ文字列を英訳とセットで辞書へ追加してください。

## 動かす

Node.js 22以降と Chrome（または Chromium）があれば、`npm install` は不要です。

```sh
npx wrangler dev      # ローカルで動かす
```

バックエンド無しでも動きます。`public/` を適当な静的サーバーで配ると、
AIとギャラリー以外の全機能が使えます（`file://` では動きません）。

## テスト

変更を送る前に、この3本を通してください。

```sh
node scripts/test-project-format.mjs   # Project JSONの往復
node scripts/test-mcp-server.mjs       # MCPツールとstdio越しのJSON-RPC
node scripts/test-web-app.mjs          # headless Chromeで実際に描画させる回帰テスト
```

3本目は `public/` を一時ディレクトリへ複製し、検証コードを足して headless Chrome で
実際に描画させます。シェーダやWebGLまわりを触ったときは、必ずこれを通してください。
Chromeが見つからない環境では自動でスキップします（`CHROME_BIN` で場所を指定できます）。

## Pull Request

- コミットメッセージは日本語で、何を・なぜ変えたかを書いてください
- UIに文字を足したら `public/i18n.js` の英訳も一緒に
- 大きな機能は先に Issue で方針を相談してもらえると進めやすいです

## セキュリティ

脆弱性を見つけた場合は、公開の Issue ではなくリポジトリの Security タブから
非公開で報告してください。
