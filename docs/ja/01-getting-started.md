# 01 環境構築と初回起動

<p align="center">
  <a href="../cn/01-getting-started.md">简体中文</a> · <a href="../en/01-getting-started.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="conntent-table.md">📚 開発者ドキュメント TOP</a> · <b>← 前のページ：なし</b> · <a href="02-architecture.md">次のページ：02 アーキテクチャ →</a>
</p>

---

このページでは、まっさらな環境から「Bot がグループ内で正常に動作する」状態までを最短手順で案内します。各手順の設計上の理由は [02 アーキテクチャ概要](02-architecture.md) を参照してください。

## 前提条件

- **`/proc` を読み取れる Linux**：インスタンスロックは `/proc/<pid>/stat` と boot ID に依存します。ほかのプラットフォームでは fail-closed で起動を拒否します。
- **Bun 1.3+**：`curl -fsSL https://bun.sh/install | bash` でインストールします。すべてのスクリプト、テスト、実行環境は Bun を使用し、Node.js は不要です。
- **Telegram Bot Token**：[@BotFather](https://t.me/BotFather) で `/newbot` を実行して作成します。
- **設定した AI 能力の API Key**：`config/agent.json` の各能力が key、provider、endpoint、model を個別に持ちます。[Google AI Studio](https://aistudio.google.com/)、[OpenAI Platform](https://platform.openai.com/)、または設定した互換サービスから取得します。能力間の fallback はありません。
- **任意：Google Cloud サービスアカウント JSON**：`/ja_copy` の日本語翻訳を使う場合だけ必要で、プロジェクトルートに `g-auth.json` として保存します。欠落や破損時は `/ja_copy` がこのファイルを名指しして拒否し、自動 copy の ja 変換は通常の copy に退化します。いずれかのチャットで `/ja_copy enable` が有効なままなら起動を拒否します。

## インストール

```bash
git clone https://github.com/Asashishi/copy_ninjia.git
cd copy_ninjia
bun install
mkdir -p config
cp -n config_example/*.json config/
```

## Telegram identity の設定

全 field と能力の説明は
[`config_example/README/ja.md`](../../config_example/README/ja.md) を参照してください。
Bot identity とスーパー管理者は `config/telegram.json` に置きます。

- **`bot_token`**（必須）
  - BotFather が発行した token。
- **`super_admin_user_id`**（必須）
  - スーパー管理者を表す 1 つの十進ユーザー ID。この identity 自体が
    `whitelist.json` で付与できる**すべて**の個別 permission を持つため、
    `whitelist.json` に entry を書く必要は**ありません**。常に allowlist 境界の
    内側にもいるので、copy cooldown 免除、Bot 認証の代行保証、自動処分からの保護も
    受け、`/block`、`/mute`、`/batch_kick` の対象にもできません。
  - identity だけで決まり `whitelist.json` では付与できない操作が 5 つあります：
    `/init`、`/batch_kick`、`/permission` の変更操作、`/white`、`/send`。
  - allowlist identity は `/permission query` で自身の permission を照会し、
    `/permission help` で説明を確認できます。スーパー管理者の `query` は全開の
    view を返します。
AI の provider、API key、endpoint、model は能力ごとに `config/agent.json` へ置きます。
runtime data を移す場合は process environment に `COPY_NINJIA_DATA_ROOT` を設定し、
未指定ならプロジェクトルートを使います。詳細は
[07 運用とトラブルシューティング](07-operations.md#データルート) を参照してください。
日本語翻訳を使う場合は、サービスアカウントキーをプロジェクトルートの
`g-auth.json` に保存します。この file は `.gitignore` の対象です。

## プロジェクト側の設定ファイル

`config/` は deployment 固有の設定ディレクトリで、Git の追跡対象外です。初回だけ `config_example/` からコピーし、その後は `config/` だけを編集してください。example ディレクトリは実行時設定ではありません。

- **[`prompt/persona.md`](../../prompt/persona.md)**
  - **内容**：AI チャットの基本ペルソナ。
  - **検証**：プレーンテキスト、schema なし。
- **`config/telegram.json`**（[example](../../config_example/telegram.json)）
  - **内容**：Bot API token と唯一のスーパー管理者 user ID。
  - **検証**：[`packages/config/telegram.ts`](../../packages/config/telegram.ts)。network
    接続前に厳密ロードし、欠落、未知 field、空 token、不正な ID は startup を拒否します。
- **`config/whitelist.json`**（[example](../../config_example/whitelist.json)）
  - **内容**：ユーザー／チャンネル allowlist と個別 permission。membership 自体も
    copy cooldown 免除、Bot 認証の代行保証、自動処分からの保護を与えます。
    スーパー管理者はここに書く必要も書くべきでもありません。permission は
    identity 自体から来るため、書いた entry は二度と読まれません。
  - **検証**：
    [`packages/config/whitelist.ts`](../../packages/config/whitelist.ts)。network
    接続前に厳密ロードし、欠落・破損時は起動を拒否します。
- **`config/blocklist.json`**（[example](../../config_example/blocklist.json)）
  - **内容**：deployment が手動管理する静的ユーザー／チャンネル blocklist ID。
  - **検証**：
    [`packages/config/blocklist.ts`](../../packages/config/blocklist.ts)。network
    接続前に厳密ロードし、動的な `memory/` layer と結合します。
- **`config/stickers.json`**（[example](../../config_example/stickers.json)）
  - **内容**：AI が使えるスタンプパック、最大 5 個。
  - **検証**：[`packages/config/stickers.ts`](../../packages/config/stickers.ts)。
- **`config/reactions.json`**（[example](../../config_example/reactions.json)）
  - **内容**：AI が使える絵文字リアクション。
  - **検証**：[`packages/config/reactions.ts`](../../packages/config/reactions.ts)。
- **`config/mood.json`**（[example](../../config_example/mood.json)）
  - **内容**：ムードの文面、重み、天気・時間帯の倍率。
  - **検証**：[`packages/config/mood.ts`](../../packages/config/mood.ts)。重みは正の整数で、
    合計がちょうど 100 でなければなりません。
- **`config/ad_samples.json`**（[example](../../config_example/ad_samples.json)）
  - **内容**：広告検出の判定基準となる例文。ファイル自体が文字列配列です。
  - **検証**：
    [`packages/config/adSamples.ts`](../../packages/config/adSamples.ts)。空文字と重複は
    不可、最大 500 件です。

- **`config/agent.json`**（[example](../../config_example/agent.json)）
  - **内容**：`agent.ad_detect`、`text`、`summary`、`media`、`image`、`song`。
    各能力が `provider`、`api_key`、任意の `base_url`、`model` を個別に持ちます。
    provider は現在 `google` と `openai` のみです。AI 雑談には `text`、`summary`、
    `media` が必須です。`image` と `song` が無い場合は対応 tool だけを外し、
    `ad_detect` が無い場合は広告検出だけを止めます。OpenAI 画像能力では
    `image_protocol`（`openai`、`openai-standard`、`xai`）も必須です。`base_url` は
    `https` のみを受け付け、平文 `http` は `localhost`・`127.0.0.1`・`::1` に限られます。
    URL に userinfo と `#` fragment は含められません。
  - **検証**：[`packages/config/agent.ts`](../../packages/config/agent.ts)。未知 key、空の
    key/model、不正な provider・URL・protocol は拒否します。**設定 file 全体は起動時に
    main thread が一度だけ parse し**、各 Worker には init message で渡します。Worker 側は
    その snapshot を読むだけで disk には触れず、crash 後の再生成でも同じ snapshot を replay
    するため、同一 process 内に 2 世代の設定が並ぶことはありません。変更後は process 全体の
    再起動が必要です。vision と voice の対応可否は最初の実 request で別々に probe し、
    明示的に非対応の modality と、404/405 で model や path の不在を示した endpoint
    （後者は `$.agent.media` を指す診断を 1 行記録）はどちらも以後 download しません。
    一時的な障害は回数に応じた backoff だけで、能力を恒久的に閉じることはありません。

`whitelist.json` と `blocklist.json` は startup security boundary です。その他は feature
単位で検証し、AI 雑談は補助設定と `agent.json` の会話能力、広告検出は sample と
`agent.ad_detect`、日本語翻訳は `g-auth.json` を読みます。欠落は対応 toggle だけを
拒否しますが、state 上ですでに有効なら startup を拒否します。修復後は再起動が必要です。

### 2.1.0 からのアップグレード

旧 process を停止し、deployment 所有の `config/` 全体を backup してください。旧
`gemini.json`、`openai.json` と AI 環境変数にあった model、endpoint、API key を統一
`agent.json` へ手動移行します。`config_example/` で deployment 設定を上書きしてはいけません。
`state.json.global.model` の runtime 選択はもう読みません。model 変更は停止中に該当能力を
編集し、再起動して反映します。

旧 `.env` の `PRIVILEGED_USERS_ID` にある各 ID を `whitelist.json` の key へ手動移行し、その環境変数を削除します。copy cooldown 免除、Bot 認証の代行保証、自動処分からの保護だけが必要なら値は空 object `{}` で構いません。旧 `/block` と `/unblock` の能力を維持するには `"isCanBlock": true` と `"isCanUnBlock": true` を明示し、その他は必要な permission だけ有効にします。スーパー管理者は移行不要です。permission は `config/telegram.json` の identity 自体から来るためで、旧構成で allowlist に載せていた場合もその entry はもう読まれないので放置して構いませんし、`/white <スーパー管理者 id> disable` で消しても構いません。allowlist identity は `/permission help` で全 key と説明を確認し、`/permission query` で default 適用後の自身の完全な permission を照会できます。`/white` と `/permission` の変更操作はこの file を atomic rewrite するため、runtime user には `config/` directory の write permission が必要です。その他の設定は read-only のままで構いません。

**例外として、機能が有効なままの場合は従来どおり起動を拒否します。** `state.json` の `true` は管理者が明確に有効化したものであり、これを黙って「何もしない」状態に格下げすると、グループからは Bot がある再起動を境に雑談・広告検出・翻訳をやめたようにしか見えません。そこで起動時に一度だけ照合します。いずれかのチャットで有効なままの任意機能は、資格情報と設定が揃っていなければならず、欠けていればチャット id と欠落項目を示して起動を拒否します（[`packages/app/featurePreflight.ts`](../../packages/app/featurePreflight.ts) を参照）。対処は前提を復旧するか、取り除く前に `/ai_chat disable`、`/ad_detect disable`、`/ja_copy disable` を実行することです。

### 運勢サムネイルと Bot 既定アバターの差し替え

インライン運勢（`/luck_challenge`）のサムネイル 2 枚と、`/reset_icon`・`/stop_copy` で復元する既定アバターの直リンクは、いずれも `state.json` の `global.assets` にあります。

```json
"global": {
  "assets": {
    "fortuneThumbnailUrl": "https://…",
    "probabilityThumbnailUrl": "https://…",
    "botDefaultAvatarUrl": "https://…"
  }
}
```

3 つのキーは順に、運勢結果のサムネイル、確率結果のサムネイル、アバター復元時に取得する画像です。`state.json` は厳格な `JSON.parse` を通るため、ブロックに `//` コメントを含めることはできません。

3 項目は起動成功時に内蔵の既定値で補完されるため、ファイルを開けば現在有効なアドレスが並んでおり、そのまま書き換えられます。要件は **画像バイトを直接返す絶対 URL** であることで、画像ホストは限定しません（内蔵の既定値がたまたま Google Drive の直リンクなだけで制約ではありません。Drive を使う場合、`/file/d/<id>/view` の共有リンクは画像バイトではなく Web ページを返す点に注意してください）。サムネイル 2 枚は Telegram クライアントが取得するため `https://` のみを受け付けます。明文の `http://` を許すのは `botDefaultAvatarUrl` だけで、この画像は Bot 自身が取得するため TLS を使うかは運用側の判断です。この取得は**リダイレクトを追います**。そのため「直リンクがまず実ストレージのドメインへ 302 する」という一般的な形（内蔵既定の Drive リンクもこれです）はそのまま指定でき、最終ホップを自分で解決する必要はありません。`https://` の書き忘れなど壊れた値は、既定画像へ黙って戻すのではなく、起動時に `state.json` 全体を拒否してフィールドパスを示します。

> `state.global.assets` が導入される前のバージョンから上げる場合は、**起動前にこの 3 項目を確認**してください：サムネイル 2 枚は現在 `https` のみを受け付けるため、以前 `http://` で設定していたものはデコード時に起動を拒否し、フィールドパスを示します。

**変更は停止中に行います**：稼働中のプロセスは正式な状態をメモリに保持しファイル全体を上書きするため、`systemctl stop` → 編集 → `systemctl start` の順です（[07 運用とトラブルシューティング](07-operations.md) を参照）。

## Telegram 側の設定（BotFather とグループ）

1. `/setprivacy` で Privacy Mode を無効にします。有効なままだと通常のグループメッセージを取得できず、copy と AI メモリが機能しません。
2. Bot をグループに追加し、メッセージ削除、メンバーの BAN、グループ管理の管理者権限を与えます。参加認証と Anti-Raid は必要な権限がある場合だけ動作し、さらにグループ内で `/antiraid enable`（既定は無効）を実行する必要があります。
3. `/setinline` で Inline Mode を有効にします。運勢抽選の `@Bot 所求事項` に必要です。
4. `/setinlinefeedback` を 100% に設定します。`chosen_inline_result` が抽選結果の確認と永続化の主経路で、メッセージ内の署名付き receipt は補助確認経路です。

## 初回起動

```bash
bun run check     # 規約 + ESLint + tsc + 全ソースカバレッジ。最初に環境が正常か確認
bun run start     # ロングポーリングを開始
```

起動に成功したら、`SUPER_ADMIN_USER_ID` が対象グループで次を実行します。

```text
/init enable      # グループの業務処理入口を有効化。未初期化グループの通常 update はゲートウェイで破棄されます
/ai_chat enable   # 任意：このグループの AI チャットを有効化
/ad_detect enable # 任意：広告検出を有効化。Bot がこのグループの管理者のときだけ実際に発火します
/antiraid enable  # 任意：参加認証と対レイド private mode を有効化。同じく管理者権限が必要です
```

`/antiraid` は 2 つのことを同時に管理します：新規メンバーのボタン認証（タイムアウトで排除）と、短時間に大量参加があったとき招待権限を閉じる private mode です。既定で無効で、無効の間はどちらの系列もイベントを 1 つも発火しません。広告検出・連投ミュート・永久ブロックリストはそれぞれ独自のスイッチを持ち、影響を受けません。権限キーは `isCanControllAntiRaidPermission`（スーパー管理者は常に保持）です。

## 動作確認

- 誰かのメッセージに返信して `/copy` を送ると、Bot がそのユーザーの copy とアバター同期を開始します。
- エラーが発生すると `logs/` にログファイルが作られます。エラーがなければ空のままの場合があります。`state.json` は初回の起動成功時に作成されます——起動が完全に成功した時点で `global.assets` の素材直リンクが現在有効な値で補完され、永続化されます（次節を参照）。
- `Ctrl+C` で停止すると、入口の quiesce、各キューの drain、状態の flush を行ってから正常終了します。

データルートの事前検査、`bot.lock`、state 検証による起動失敗は意図的な fail-fast です。[07 運用とトラブルシューティング](07-operations.md#起動失敗の調査) に従って対応してください。

---

<div align="center">

**← 前のページ：なし** · [📚 開発者ドキュメント TOP](conntent-table.md) · [⬆️ トップへ戻る](#01-環境構築と初回起動) · [次のページ：02 アーキテクチャ →](02-architecture.md)

</div>
