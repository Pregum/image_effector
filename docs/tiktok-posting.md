# TikTok Content Posting API を NOIZ LAB へつなぐ手順

書き出したMP4を、NOIZ LABから直接TikTokへ下書き保存／投稿するための手順書です。
**未実装**です。TikTok側で開発者アプリの登録と審査、そして利用者アカウントでのOAuth連携が
必要で、こちらの都合だけでは進められないため、手順だけ残しています。

エンドポイントやフィールド名はTikTok側の都合で変わります。着手時は必ず
[公式ドキュメント](https://developers.tiktok.com/doc/content-posting-api-get-started/)で
最新版を確認してください。ここに書いてあるのは、**TikTok APIで何ができるか**の一覧と、
実際につなぐときの段取り、そしてNOIZ LAB側で必要になる作業です。

---

## できること一覧

2026年9月2日時点の[公式ドキュメント](https://developers.tiktok.com/doc/overview/)を読んで整理したものです。
「NOIZ LABでどう効くか」は、いまのアプリの機能に照らした見立てです。

### 投稿する — Content Posting API

| できること | スコープ | NOIZ LABでどう効くか |
| --- | --- | --- |
| 動画を**下書き**として送る（TikTokアプリの受信箱に届き、本人が仕上げて出す） | `video.upload` | 書き出したMP4をそのまま送れる。投稿の最終判断は人が持つので事故が起きない |
| 動画を**直接投稿**する（APIで公開まで完了） | `video.publish` | 定期投稿の自動化。ただし審査前は公開範囲が自分だけに制限される |
| **写真**を複数枚まとめて投稿する（`/v2/post/publish/content/init/`） | `video.publish` | サムネ・カルーセル用途。1枚絵の書き出しがそのまま素材になる |
| 投稿前に**creator info**を取る | 同上 | 公開範囲の選択肢、コメント／デュエット／ステッチの可否、そのアカウントの**最大尺**が返る。レビュー機能の「尺が長すぎます」を推測ではなく実際の上限で言える |
| 投稿の**進行状況**を追う（`/v2/post/publish/status/fetch/`） | 同上 | 「送信中 → 処理中 → 完了」をUIに出せる |

動画は `video/mp4` / `video/quicktime` / `video/webm` を受け付けます。渡し方は
バイト列を分割して送る `FILE_UPLOAD` と、URLを取りに来てもらう `PULL_FROM_URL` の2種類で、
後者は**そのドメインの所有確認**が要ります。アップロードURLの有効期限は発行から1時間です。

**上限**（確認できたぶんだけ）
- creator info: アクセストークンごとに **20リクエスト/分**
- 投稿の初期化・アップロード: アクセストークンごとに **6リクエスト/分**
- **24時間あたり保留中の共有は5件まで**
- 1カットの最大尺はアカウント依存（creator infoの `max_video_post_duration_sec`。300秒の例が載っています）
- ファイルサイズの上限とチャンクサイズの目安は、ドキュメント上では明示されていませんでした

### 読む — Display API

| できること | スコープ | NOIZ LABでどう効くか |
| --- | --- | --- |
| プロフィールを読む（`open_id` / `union_id` / `avatar_url` / `display_name`） | `user.info.basic` | 「どのアカウントへ出すか」の表示。連携の必須項目 |
| プロフィールの詳細（プロフィールリンク、bio、認証済みバッジ） | `user.info.profile` | 連携画面の情報量 |
| アカウント統計（フォロワー数、いいね総数など） | `user.info.stats` | 「このアカウントの規模ならこの尺」といった提案の材料 |
| **投稿済み動画の一覧・詳細**を読む | `video.list` | ここが一番おいしい（下記） |

Video オブジェクトで取れるフィールド:
`id` / `create_time` / `cover_image_url` / `share_url` / `video_description` / `duration` /
`height` / `width` / `title` / `embed_html` / `embed_link` /
**`like_count`** / **`comment_count`** / **`share_count`** / **`view_count`** / `is_aigc`

> **これで輪が閉じます。** いまのフック／テンポの自動レビューは、冒頭2秒・尺・緩急といった
> 一般論で点を付けています。`view_count` と `like_count` を投稿後に読み戻せれば、
> 「このプロジェクトのこの構成は実際に伸びた／伸びなかった」を**実測で**言えるようになります。
> 作る → 出す → 数字を取り込む → 次の構成に反映する、まで1つのツールで回ります。
>
> `is_aigc` も見逃せません。AI生成コンテンツのタグを立てるフラグなので、
> AI画像から作ったカットには正直に立てられます（このリポジトリの方針どおりです）。

### 埋め込む — oEmbed

`GET https://www.tiktok.com/oembed?url=<動画URL>` を叩くだけ。**アプリ登録もOAuthもAPIキーも不要**で、
埋め込みHTML・サムネ・タイトルが返ります。

NOIZ LABでどう効くか: 作った動画のTikTok版を、ギャラリーや作品ページにそのまま埋められます。
**いますぐ実装できる唯一のTikTok連携**で、審査待ちもありません。

### 使えないもの・遠いもの

| | なぜ |
| --- | --- |
| **Share Kit** | iOS/AndroidのSDK前提。ブラウザで完結するNOIZ LABからは呼べない |
| **Research API** | 非営利の学術機関の研究者向け。研究計画書・倫理審査・所属の証明が要り、対象は米国と欧州。EUのDSAに基づく審査済み研究者向けの枠は別立て。`view_count` などの統計を**他人の公開動画**まで広げて取れるが、このプロジェクトの立場では申請できない |
| **Data Portability API** | 利用者本人のアーカイブ書き出し（活動・投稿・DM）。ツールの用途と噛み合わない |
| **Mini Games / Local Service** | 用途が別物 |

なお `video.list` で読めるのは**連携した本人の公開動画**だけです。他人の動画の数字を集めるには
Research API が要る、という線引きになっています。

### 費用

**APIの利用料はかかりません。** 詰まるとしたら金ではなく審査と規約のほうです（下記「3. 規約まわりで守ること」）。

### おすすめの順番

1. **oEmbed** — 登録も審査も不要。今日できる
2. **下書き保存**（`video.upload`）— 審査が軽く、事故も起きない
3. **読み戻し**（`user.info.basic` + `video.list`）— レビュー機能が実測で語れるようになる。ここが本命
4. **直接投稿**（`video.publish`）— 自動化したくなったら。審査が要る

---

## 0. 先に決めること

**下書き止まり（inbox）にするか、直接投稿（direct post）まで行くか**で必要な審査が変わります。

| | 下書き保存 | 直接投稿 |
| --- | --- | --- |
| スコープ | `video.upload` | `video.publish` |
| 動き | TikTokアプリの受信箱に届き、利用者が自分で仕上げて投稿する | APIから投稿まで完了する |
| 審査 | 比較的軽い | Content Posting APIの審査が必要。通るまで公開範囲は自分だけに制限される |
| 向き | まずはこちら。NOIZ LABは「素材を作る道具」なので、投稿の最終判断は人が持つほうが素直 | 定期投稿を自動化したくなったら |

**まずは下書き保存だけを実装するのを勧めます。** 審査が軽く、投稿文やカバー画像の調整は
TikTokアプリ側のほうがやりやすく、「意図しない投稿」という事故も起きません。

---

## 1. TikTok側の登録（利用者本人の作業）

1. [TikTok for Developers](https://developers.tiktok.com/) にTikTokアカウントでログインする
2. 開発者登録（Developer Portal の規約に同意）
3. **アプリを作成**する。用途、想定利用者、スクリーンショットなどを書く
4. アプリに **Login Kit** と **Content Posting API** の2つのプロダクトを追加する
5. 必要なスコープを申請する
   - `user.info.basic`（投稿先アカウントの識別に必要）
   - `video.upload`（下書き保存）
   - 直接投稿までやるなら `video.publish`
6. **Redirect URI** を登録する（例: `https://<デプロイ先>/api/tiktok/callback`）
7. **Client Key / Client Secret** を控える
8. `PULL_FROM_URL` で動画を渡す場合は、**URLのドメイン所有確認**が別途必要
   （TikTokが指定するファイルまたはDNSレコードを置く）

> 監査前は公開範囲が `SELF_ONLY`（自分のみ）に制限されます。動作確認はそれで足ります。

---

## 2. NOIZ LAB側に足すもの

### 2-1. シークレット

```sh
npx wrangler secret put TIKTOK_CLIENT_KEY
npx wrangler secret put TIKTOK_CLIENT_SECRET
```

`src/worker.js` の他のAI／ギャラリー機能と同じく、**バインディングが無ければ機能ごと隠す**
（`/api/config` に `tiktok: false` を返し、UIのボタンを出さない）方針に揃えてください。

### 2-2. D1のテーブル

`schema.sql` に足します。アクセストークンは短命、リフレッシュトークンは長命なので、
両方と有効期限を持ちます。

```sql
CREATE TABLE IF NOT EXISTS tiktok_accounts (
  open_id TEXT PRIMARY KEY,
  display_name TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

トークンは実質パスワードなので、`/api/works` と同じくギャラリーのアクセスキーで
守られたルートからしか触れないようにします。クライアントへは絶対に返しません。

### 2-3. Workerのルート

| ルート | 役割 |
| --- | --- |
| `GET /api/tiktok/auth` | `state` を作って（CSRF対策。Cookieか短命DOに保存）TikTokの認可画面へ302 |
| `GET /api/tiktok/callback` | `code` をアクセストークンへ交換し、D1へ保存。編集画面へ戻す |
| `GET /api/tiktok/creator` | 投稿前に必須の creator info を取得して返す（公開範囲の選択肢、デュエット可否、最大尺） |
| `POST /api/tiktok/publish` | 動画を渡して下書き作成／投稿を開始し、`publish_id` を返す |
| `GET /api/tiktok/status` | `publish_id` の進行状況を返す |
| `POST /api/tiktok/disconnect` | D1からトークンを消す（連携解除） |

### 2-4. OAuthの流れ

1. 認可画面: `https://www.tiktok.com/v2/auth/authorize/` に
   `client_key` / `scope` / `response_type=code` / `redirect_uri` / `state` を付ける
2. コールバックで受け取った `code` を
   `POST https://open.tiktokapis.com/v2/oauth/token/`
   （`grant_type=authorization_code`、`client_key`、`client_secret`、`code`、`redirect_uri`）で交換
3. 返ってくる `access_token` / `refresh_token` / `open_id` / 有効期限をD1へ保存
4. アクセストークンが切れていたら `grant_type=refresh_token` で更新してから使う

### 2-5. 投稿の流れ

1. **creator info を先に取る**
   `POST https://open.tiktokapis.com/v2/post/publish/creator_info/query/`
   公開範囲の選択肢や最大尺が返る。**これを取らずに投稿画面を出すのは規約違反**で、
   利用者に選ばせる公開範囲もここで返った選択肢に限る必要があります。
2. **初期化**
   - 下書き: `POST https://open.tiktokapis.com/v2/post/publish/inbox/video/init/`
   - 直接投稿: `POST https://open.tiktokapis.com/v2/post/publish/video/init/`
     （`post_info` に `title`、`privacy_level`、`disable_duet` などを入れる）
   - `source_info` は `FILE_UPLOAD`（自分でバイト列を送る）か `PULL_FROM_URL`（URLを取りに来てもらう）
3. **`FILE_UPLOAD` の場合**: 返ってきた `upload_url` へ `PUT` でチャンク送信（`Content-Range` 付き）
4. **状態確認**: `POST https://open.tiktokapis.com/v2/post/publish/status/fetch/` に `publish_id`

### 2-6. NOIZ LABでの動画の渡し方

NOIZ LABのMP4は `MediaRecorder` でブラウザ内に作られるので、そのままでは外に出せません。
二択です。

- **`PULL_FROM_URL`（勧め）**: すでにあるR2（`IMAGES` バインディング）へ一時的に置き、
  期限付き署名URL（`signImage` と同じ作りでよい）をTikTokへ渡す。投稿完了後に消す。
  ただし**そのドメインの所有確認**をTikTok側で済ませておく必要があります。
- **`FILE_UPLOAD`**: TikTokの `upload_url` はブラウザからのCORSを想定していないので、
  Workerが中継することになります。Workerのリクエストボディ上限（無料プランで100MB）内なら
  問題ありませんが、素直にストリームで受け流す実装が要ります。

R2に一時的に置く場合は、既存の共有画像と同じく**期限を明示**してください
（現状のサンプル以外の共有画像は約1日で消える、という説明と揃える）。

---

## 3. 規約まわりで守ること

- **投稿前に必ず利用者へ確認画面を出す。** ボタン一発で投稿されるUIにしない
- 公開範囲は creator info が返した選択肢からしか選ばせない
- 商用コンテンツ（プロモーション、ブランド案件）の申告UIを出す
- TikTokのブランド表記・ロゴのガイドラインに従う
- 連携解除の導線を必ず置く（`POST /api/tiktok/disconnect`）
- 利用規約とプライバシーポリシーのURLがアプリ審査で必要になる。
  `/about` を拡張するのが早いです

---

## 4. 無料と適法の観点

- **API利用料は無料。** Content Posting API に課金はありません
- R2・D1・Workerの追加分もいずれも無料枠の範囲（動画は投稿後に消す前提）
- 気をつけるのは**規約**のほう。上の「3. 規約まわりで守ること」を満たさないと
  アプリの審査に落ちるか、通った後に止められます

---

## 5. 実装の順番（提案）

0. **oEmbed だけ先に入れる。** 登録も審査も要らないので、ここは今日できます
1. TikTok側でアプリ登録・`video.upload` と `user.info.basic` を申請（利用者本人の作業）
2. シークレットとD1テーブルを足す
3. OAuthの往復（`/api/tiktok/auth` → `/api/tiktok/callback`）だけ先に通す
4. creator info を取って、公開範囲などを出すだけの確認画面を作る
5. `PULL_FROM_URL` で下書き保存まで通す
6. 状態確認と連携解除を足す
7. **`video.list` を足して、投稿した動画の再生数といいねを読み戻す。**
   ここまで来ると、フック／テンポの自動レビューが一般論ではなく実測で語れるようになります
8. 直接投稿が要るなら、そこで `video.publish` の審査を申請する

---

## 参考にしたページ

- [Developer Overview](https://developers.tiktok.com/doc/overview/)
- [Content Posting API — Get Started](https://developers.tiktok.com/doc/content-posting-api-get-started/)
- [Content Posting API — Upload Video](https://developers.tiktok.com/doc/content-posting-api-reference-upload-video/)
- [Content Posting API — Query Creator Info](https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info/)
- [Display API — Get Started](https://developers.tiktok.com/doc/display-api-get-started/)
- [Video Object](https://developers.tiktok.com/doc/tiktok-api-v2-video-object)
- [Scopes](https://developers.tiktok.com/doc/tiktok-api-scopes/)
- [Embed Videos / oEmbed](https://developers.tiktok.com/doc/embed-videos/)
- [Research Tools: Access and Eligibility](https://developers.tiktok.com/products/research-api/)
