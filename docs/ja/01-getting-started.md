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
- **任意：Google Cloud サービスアカウント JSON**：`/ja_copy` の日本語翻訳を使う場合だけ必要で、プロジェクトルートに `g-auth.json` として保存します。欠落時は `/ja_copy` がこのファイルを名指しして拒否し、自動 copy の ja 変換は通常の copy に退化しますが、起動は妨げられません。ファイルが存在して壊れている場合は、起動時の総ゲートが解析段階で起動を拒否します。

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
    allowlist で付与できる**すべて**の個別 permission を持つため、
    SQLite allowlist table に row を書く必要は**ありません**。常に allowlist 境界の
    内側にもいるので、copy cooldown 免除、Bot 認証の代行保証、自動処分からの保護も
    受け、`/block`、`/mute`、`/batch_kick` の対象にもできません。
  - `/init`、`/batch_kick`、`/permission` の変更操作、`/white disable`、`/send` は
    identity だけで決まります。`isCanWhiteOther` は他 identity の default permission での
    追加だけを委任し、member を削除できません。
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

allowlist、blocklist、未完了 removal は deployment JSON ではなく、runtime data root の
`database/storage.sqlite` にあります。Disk I/O Worker は startup 時に SQLite integrity、
migration lineage、schema version、JSONB row shape、policy の非重複を検証します。その他は
feature 単位で検証し、日本語翻訳は `g-auth.json` を読みます。欠落は対応 toggle とその機能の
実行経路だけを拒否し、起動は妨げません。ただし**ファイルが存在する限り厳密なパースを
通らなければならず**、対応機能が今オフでも不正な内容は起動を拒否します
（[`packages/config/readiness.ts`](../../packages/config/readiness.ts) の
`validateExistingDeploymentInputs` を参照）。修復後は再起動が必要です。

### identity storage の初期化

runtime は database 欠落を空 table と推測しません。新規 deployment は migration 専用の空 legacy
input を用意し、target が存在しないことを確認して明示 migration します。

```bash
test ! -e config/whitelist.json
test ! -e config/blocklist.json
printf '{}\n' > config/whitelist.json
printf '{"blockedIds":[]}\n' > config/blocklist.json
bun run migrate:identity-storage --apply
```

script は `bot.lock` を取得し、owner/mode/SHA-256 inventory 付き外部 backup を残し、現行
`database/storage.sqlite` を atomic publish して 2 つの temporary legacy file を削除します。
既存 legacy deployment は空 file で上書きせず、[運用文書](07-operations.md#identity-storage-migration)
に従って実データを migration してください。

### 2.1.0 からのアップグレード

旧 process を停止し、deployment 所有の `config/` 全体を backup してください。旧
`gemini.json`、`openai.json` と AI 環境変数にあった model、endpoint、API key を統一
`agent.json` へ手動移行します。`config_example/` で deployment 設定を上書きしてはいけません。
`state.json.global.model` の runtime 選択はもう読みません。model 変更は停止中に該当能力を
編集し、再起動して反映します。

旧 `.env` の `PRIVILEGED_USERS_ID` にある各 ID は、環境変数を削除する前に legacy allowlist input へ移し、identity storage migration を実行します。migration 後の SQLite を手編集してはいけません。membership だけ必要なら値は空 object `{}` で構わず、その他は必要な permission だけ有効にします。スーパー管理者は allowlist table へ移行せず、permission は `config/telegram.json` の identity 自体から得ます。migration 後は `/permission help` で key を確認し、`/permission query` で自身の完全な view を照会できます。`/white` と `/permission` は database transaction で永続化するため、`config/` は read-only のままで構いません。

**注意：資格情報を外しても起動は拒否されませんが、そのグループは静かに止まります。** 起動時の総ゲートが検証するのは**すでに存在する**デプロイ入力だけです（[`packages/app/featurePreflight.ts`](../../packages/app/featurePreflight.ts) を参照。現在は `packages/config/readiness.ts` の `validateExistingDeploymentInputs` を再 export するだけです）。存在するファイルは厳密なパースを通らなければならず、本当に存在しないファイルは起動を妨げません。`chat_states` の `true` は従来どおり復元されますが、対応機能は唯一の判定入口で利用不可と判定されます——AI 雑談の Worker はそもそも起動せずメモリも hydrate されず（`memory/` のスナップショットは前提が戻るまでそのまま保持されます）、`/ja_copy` は通常コピーへ退化し、広告検出は bundle を送らなくなります。グループからは Bot がある再起動を境に雑談・広告検出・翻訳をやめたようにしか見えず、痕跡は `logs/` の 1 行だけです。したがって資格情報を外す前に `/ai_chat disable`、`/ad_detect disable`、`/ja_copy disable` を実行するか、前提そのものを復旧してください。

### インラインサムネイルと Bot 既定アバターの差し替え

インライン結果のサムネイル 3 枚（`/luck_challenge` の 2 枚と gag 発言入口の 1 枚）と、`/reset_icon`・`/stop_copy` で復元する既定アバターの直リンクは、いずれも `state.json` の `global.assets` にあります。

```json
"global": {
  "assets": {
    "fortuneThumbnailUrl": "https://…",
    "probabilityThumbnailUrl": "https://…",
    "gagThumbnailUrl": "https://…",
    "botDefaultAvatarUrl": "https://…"
  }
}
```

4 つのキーは順に、運勢結果のサムネイル、確率結果のサムネイル、gag 発言 inline 結果のサムネイル、アバター復元時に取得する画像です。`state.json` は厳格な `JSON.parse` を通るため、ブロックに `//` コメントを含めることはできません。

4 項目は起動成功時に内蔵の既定値（[`packages/consts/ui/assets.ts`](../../packages/consts/ui/assets.ts)）で補完されるため、ファイルを開けば現在有効なアドレスが並んでおり、そのまま書き換えられます。要件は **画像バイトを直接返す絶対 URL** であることで、画像ホストは限定しません（内蔵の既定値がたまたま Google Drive の直リンクなだけで制約ではありません。Drive を使う場合、`/file/d/<id>/view` の共有リンクは画像バイトではなく Web ページを返す点に注意してください）。サムネイル 3 枚は Telegram クライアントが取得するため `https://` のみを受け付けます。明文の `http://` を許すのは `botDefaultAvatarUrl` だけで、この画像は Bot 自身が取得するため TLS を使うかは運用側の判断です。この取得は**リダイレクトを追います**。そのため「直リンクがまず実ストレージのドメインへ 302 する」という一般的な形（内蔵既定の Drive リンクもこれです）はそのまま指定でき、最終ホップを自分で解決する必要はありません。`https://` の書き忘れなど壊れた値は、既定画像へ黙って戻すのではなく、起動時に `state.json` 全体を拒否してフィールドパスを示します。

> `state.global.assets` が導入される前のバージョンから上げる場合は、**起動前にこの 4 項目を確認**してください：サムネイル 3 枚は現在 `https` のみを受け付けるため、以前 `http://` で設定していたものはデコード時に起動を拒否し、フィールドパスを示します。

**変更は停止中に行います**：稼働中のプロセスは正式な状態をメモリに保持しファイル全体を上書きするため、`systemctl stop` → 編集 → `systemctl start` の順です（[07 運用とトラブルシューティング](07-operations.md) を参照）。

## Telegram 側の設定（BotFather とグループ）

1. `/setprivacy` で Privacy Mode を無効にします。有効なままだと通常のグループメッセージを取得できず、copy と AI メモリが機能しません。
2. Bot をグループに追加し、メッセージ削除、メンバーの BAN、グループ管理の管理者権限を与えます。参加認証と Anti-Raid は必要な権限がある場合だけ動作し、さらにグループ内で `/antiraid enable`（既定は無効）を実行する必要があります。
3. `/setinline` で Inline Mode を有効にします。運勢抽選の `@Bot 所求事項` に必要です。
4. `/setinlinefeedback` を 100% に設定します。`chosen_inline_result` が抽選結果の確認と永続化の主経路で、メッセージ内の署名付き receipt は補助確認経路です。

## 初回起動

```bash
bun run check     # 規約 + ESLint + tsc + 全ソースカバレッジ + hot path gate。最初に環境が正常か確認
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
