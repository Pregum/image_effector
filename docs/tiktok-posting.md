# TikTok Content Posting API を NOIZ LAB へつなぐ手順

書き出したMP4を、NOIZ LABから直接TikTokへ下書き保存／投稿するための手順書です。
**未実装**です。TikTok側で開発者アプリの登録と審査、そして利用者アカウントでのOAuth連携が
必要で、こちらの都合だけでは進められないため、手順だけ残しています。

エンドポイントやフィールド名はTikTok側の都合で変わります。着手時は必ず
[公式ドキュメント](https://developers.tiktok.com/doc/content-posting-api-get-started/)で
最新版を確認してください。ここに書いてあるのは全体の段取りと、NOIZ LAB側で必要になる作業です。

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

1. TikTok側でアプリ登録・`video.upload` だけ申請（利用者本人の作業）
2. シークレットとD1テーブルを足す
3. OAuthの往復（`/api/tiktok/auth` → `/api/tiktok/callback`）だけ先に通す
4. creator info を取って、公開範囲などを出すだけの確認画面を作る
5. `PULL_FROM_URL` で下書き保存まで通す
6. 状態確認と連携解除を足す
7. 直接投稿が要るなら、そこで審査を申請する
