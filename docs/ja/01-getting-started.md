# 01 環境構築と初回起動

<p align="center">
  <a href="../cn/01-getting-started.md">简体中文</a> · <a href="../en/01-getting-started.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 開発者ドキュメント TOP</a> · <b>← 前のページ：なし</b> · <a href="02-architecture.md">次のページ：02 アーキテクチャ概要 →</a>
</p>

---

このページでは、まっさらな環境から「Bot がグループ内で正常に動作する」状態までを最短手順で案内します。システム構成とメッセージフローは [02 アーキテクチャ概要](02-architecture.md) を参照してください。

## 前提条件

- **`/proc` を読み取れる Linux**：インスタンスロックは `/proc/<pid>/stat` とシステム boot ID に強く依存します。それ以外の OS では fail-closed で起動を拒否します。
- **Bun 1.4.2**：ソース方式のインストールおよびローカル開発に必要です。以下のコマンドで導入できます：
  ```bash
  curl -fsSL https://bun.sh/install | bash -s bun-v1.4.2
  ```
  > [!NOTE]
  > バイナリ配布版には内蔵 Bun ランタイムが同梱されているため、ホストマシンへの Bun の事前導入は不要です。プロジェクト全域で Node.js は一切使用しません。
- **Telegram Bot Token**：[@BotFather](https://t.me/BotFather) に `/newbot` を送信して Bot を作成し、Token を取得します。
- **設定する AI 能力の API Key**：`config/dynamic/agent.json` で設定する各能力（対話、メディア解説、画像生成、TTS、Web 検索など）が、それぞれ API Key、provider、エンドポイント、モデルを保持します。[Google AI Studio](https://aistudio.google.com/)、[OpenAI Platform](https://platform.openai.com/)、または互換サービスから取得してください。能力間の自動フォールバックはありません。
- **（任意）Google Cloud サービスアカウント JSON**：`/translate` 翻訳機能のみで必要となり、`config/static/g-auth.json` として保存します（構造は [サンプル](../../config_example/static/g-auth.json) を参照。サンプルのプレースホルダー秘密鍵はパーサーにより拒否されます）。
  - **認証情報仕様**：`packages/config/googleAuth.ts` が厳格に解析します。`client_email` と、RS256 署名用の空でない RSA PEM 秘密鍵（EC、Ed25519、RSA-PSS 鍵は拒否）が必須です。`type` は省略可能で、存在する場合は `service_account` のみ受け付けます。
  - **グレースフルデグラデーション**：認証情報が欠落していてもプロセスの起動は妨げられず、`/translate` 実行時にのみ明示的に同ファイルを名指しして拒否します。ファイルが存在するものの形式が不正な場合は、起動時の総ゲートにより解析段階で直ちに終了します。
  - **セキュリティ**：起動段階でプロセスレベルの読み取り専用スナップショットを生成し、実行時にディスクを再読み込みしません。エラーメッセージにはファイルパスと期待されるフィールド形式のみを出力し、秘密情報の平文値は一切露出しません。

---

## インストール

### ワンショットインストール

新規サーバー環境では、自動化スクリプト [`install.sh`](../../install.sh) の利用を推奨します：

```bash
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash
```

引数または環境変数でインストールモードを明示指定できます（いずれか一方のみ使用）：

```bash
# バイナリ配布版インストール（素早いデプロイに推奨、git やシステム Bun 不要）
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash -s -- --binary

# ソースコードインストール（その後の二次開発に適しています）
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash -s -- --source
```

#### インストール方式の比較と動作

<table width="100%">
<thead>
  <tr>
    <th width="20%" align="left">比較項目</th>
    <th width="40%" align="left">バイナリ配布版 (<code>--binary</code>)</th>
    <th width="40%" align="left">ソースコード版 (<code>--source</code>)</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr>📦 <b>配布チャネル</b></nobr></td>
    <td>GitHub Latest Release から対応パッケージを自動取得</td>
    <td>該当 Release tag を <code>git clone</code>（detached HEAD）</td>
  </tr>
  <tr>
    <td><nobr>⚙️ <b>依存関係</b></nobr></td>
    <td>システム Bun・git・ローカルコンパイルは不要。ダウンロード用ツールが不足していればインストーラーが導入を試みます</td>
    <td>git と Bun 1.4.2 を使用。不足分はインストーラーが導入を試みますが、既存 Bun のバージョン不一致は手動で修正します</td>
  </tr>
  <tr>
    <td><nobr>🚀 <b>ランタイム</b></nobr></td>
    <td>Bun ランタイムと Worker 群を内蔵した単一バイナリ</td>
    <td><code>bun install --frozen-lockfile</code>（7 日間の依存関係冷却期間）</td>
  </tr>
  <tr>
    <td><nobr>▶️ <b>起動コマンド</b></nobr></td>
    <td>直下に展開された <code>./copy-ninjia</code> を実行</td>
    <td><code>bun run start</code> または <code>bun run index.ts</code> を実行</td>
  </tr>
</tbody>
</table>

> [!TIP]
> **インストールプロセスの概要**：
> 1. **環境とアーキテクチャの検証**：Linux および `/proc` の利用可否を確認し、Linux x64/arm64 と glibc/musl を自動識別します。
> 2. **デプロイ設定の準備**：不足している設定テンプレートのみを補い、`agent.json`、`g-auth.json`、`cron.json` はスキップします。既存ファイルはワークツリー外へバックアップしてから検証し、原子的に置換します。生成ファイルのパーミッションは `600` に厳格設定されます。
> 3. **ID データベースの初期化**：本番パスに従って `database/storage.sqlite` を検証します。既存の場合は固定されたタイムゾーンが `bot.json` の `time_zone` と一致することを読み取り専用で照合し、不一致ならサービス登録前に終了します。存在しない場合は `bot.json` のタイムゾーンで現行スキーマの空データベースを新規初期化します。
> 4. **サービス登録と稼働監視**：`copy-ninjia.service` を自動登録または再利用し、起動後にサービス状態を動的に監視して、`active/running`、再起動回数の安定、および journal に異常がないことを確認してからバックアップを削除します。

### ソースからの手動インストール

```bash
# 1. リポジトリをクローン
git clone https://github.com/Asashishi/copy_ninjia.git
cd copy_ninjia

# 2. 依存関係をロックしてインストール
bun install

# 3. デプロイ設定ディレクトリを準備
mkdir -p config/static config/dynamic
for example in config_example/static/*.json config_example/dynamic/*.json; do
  case "${example##*/}" in
    g-auth.json | cron.json) ;;
    *) cp -n "$example" "config/${example#config_example/}" ;;
  esac
done
```

> [!WARNING]
> `g-auth.json` と `cron.json` のサンプルは書き方を示すためのものであり、本番環境へそのままコピーしないでください。詳細な説明は [`config_example/README/ja.md`](../../config_example/README/ja.md) を参照してください。

---

## Telegram identity の設定

Bot の基本 identity とグローバルスーパー管理者は `config/static/bot.json` で定義します：

- **`bot_token`**（必須、文字列）
  - BotFather から取得した Telegram Bot API Token。
- **`super_admin_user_id`**（必須、正の整数）
  - スーパー管理者の単一十進ユーザー ID。
  - **特権境界**：この identity 自体がホワイトリストで付与可能な**全権限**を最初から保有しているため、SQLite ホワイトリストテーブルにレコードを追加する必要はありません。
  - **免除保護**：リピートや画像生成などのクールダウン免除はこの identity だけに属します。常にホワイトリスト境界の内側に位置し、自動処分の保護対象となるため、`/block`、`/mute`、`/batch_kick` で処分することはできません。
  - **専用コマンド**：`/init`、`/batch_kick`、`/permission` の変更操作、`/white disable`、`/send` の呼び出しはスーパー管理者のみに許可されています。
- **`atmosphere`**（任意、列挙型：`"mesugaki"` | `"normal"`）
  - 通知とメニューのデフォルト口調スタイル（メスガキ風 / 通常版）。
  - 明示設定を優先します。省略時は `prompt/persona.md` があれば通常版、なければメスガキ風を使います。前後の空白を除いて検証し、不正値は起動を拒否します。
- **`time_zone`**（任意、IANA タイムゾーン名、既定 `"Asia/Tokyo"`）
  - 運勢、ログ、広告の発言累計、AI の時刻、日次保守、タイムゾーンを省略した cron の既定暦タイムゾーン。
  - 前後の空白を除いて検証し、Temporal で大文字小文字を正規化します（例：`asia/tokyo` は `Asia/Tokyo`。`Japan` などの別名はそのまま保持）。空文字、不正な型、未対応のタイムゾーンは起動を拒否します。
  - データベース初期化時に `storage_metadata` の `time-zone` マーカーとして書き込まれ、データルートはそのタイムゾーンに固定されます。起動とインストーラーはこれと照合し、`time_zone` を変更すると起動を拒否します（エラーは `storage_metadata.time-zone` を示します）。既存データルートのタイムゾーン変更はサポートしていません。

---

## プロジェクト側の設定ファイル

`config/` ディレクトリはデプロイ側のプライベートデータであり、`.gitignore` で完全に除外されています。ファイルのレイアウトはサブディレクトリの分類を厳格に遵守する必要があります：

```text
config/
├── static/                 # 静的設定（変更後はプロセスの再起動が必要）
│   ├── bot.json            # Bot identity とスーパー管理者設定
│   └── g-auth.json         # Google Cloud サービスアカウント認証情報（任意）
└── dynamic/                # 動的設定（変更後約 0.5 秒で自動ホットリロード）
    ├── agent.json          # AI モデルの各能力設定
    ├── assets.json         # サムネイル、デフォルトアバター、画像ライブラリパス
    ├── stickers.json       # スタンプパックのホワイトリスト
    ├── mood.json           # ムード段階と重み
    ├── ad_samples.json     # 広告判定用の参照サンプル集
    └── cron.json           # 定時タスク設定（任意）
```

> [!IMPORTANT]
> - 設定ファイルが `config/` の直下に置かれていたり、誤ったサブディレクトリに配置されている場合、システムは起動段階で直ちに fail-closed で終了します。
> - 稼働中に `config/dynamic/` 配下のファイルを変更すると、デバウンスされたホットリロードが自動でトリガーされます。変更に構文またはスキーマのエラーが含まれている場合、その回の変更は全体が拒否されてログに記録され、直前の有効なスナップショットが維持されます。次回の再起動時までに修正されなければ起動を拒否します。

### コア設定ファイルの詳細

- **`prompt/persona.md`**（任意、プロジェクトルート。[例](../../prompt_example/persona.md)）
  - **内容**：カスタム AI チャット人設。
  - **動作**：存在しない場合はコード内蔵の人設（[`persona.ts`](../../packages/consts/aiChat/prompts/persona.ts)）を使用します。ファイルが存在する場合はその本文で人設を置き換えます。通知は明示した `atmosphere` を優先し、省略時は通常版を使います。
  - **検証**：プレーンテキスト形式。存在しても空文字または不正な UTF-8 である場合は起動を拒否します。変更後はプロセスの再起動が必要です。
  - **例**：[`prompt_example/persona.md`](../../prompt_example/persona.md) は穏やかで頼れる「先輩」の人設で、「あなたは誰か / 核となる性格 / 特性の優先順位 / 話し方 / 事実を捏造しない / 言語規範」の節に分かれています。`mkdir -p prompt && cp -n prompt_example/persona.md prompt/` でコピーし（`-n` は既存ファイルを上書きしません）、必要に応じて編集してから再起動します。ファイル本文は前後の空白を除いてそのまま人設としてモデルに渡されるため、運用者向けのメモを書かないでください。

- **`prompt/voice_tool.md`**（任意、プロジェクトルート。[例](../../prompt_example/voice_tool.md)）
  - **内容**：カスタム AI `send_voice` ツール説明。
  - **動作**：存在しない場合は `agent.tts.bot_language` に応じて内蔵の `en` / `zh` / `ja` 説明（[`tools.ts`](../../packages/consts/aiChat/prompts/tools.ts) の `VOICE_LANGUAGE_PROMPTS`）を使用します。存在する場合は `bot_language` の値にかかわらず、ファイル本文で説明全体を置き換えます。`text` / `tone` 引数の説明と、`send_message`・「行動と停止」節のボイス重複規則は引き続き `bot_language` で選ばれます。内蔵説明にある実行上の約束（このターンのツール状態にある `send_voice` 残量行の確認、1 ターンの件数と `text` / `tone` の長さ上限、受領・error 応答の扱い）はファイル側で記述する必要があります。
  - **検証**：プレーンテキスト形式。存在しても空文字または不正な UTF-8 である場合は起動を拒否し、`agent.tts` 未設定時も同様に検証します。変更後はプロセスの再起動が必要です。
  - **例**：[`prompt_example/voice_tool.md`](../../prompt_example/voice_tool.md) は上の人設例と対になっており、セリフを穏やかな日常の日本語にしたうえで、上記の実行上の約束をすべて記述しています。例にある 1 ターンの件数と `text` / `tone` の長さ上限はコードの現在の上限に合わせてあるため、編集時も一致させてください。例は `bot_language: "ja"`（[`agent.json` の例](../../config_example/dynamic/agent.json) の値）向けに書かれています。他のセリフ言語を使う場合は、冒頭の文とセリフ言語、セリフと口調の例、重複の説明をその言語に合わせて変えてください。対で使う場合は `agent.tts.style` も対応する声質の説明に替えられます。コピー方法は同じです：`mkdir -p prompt && cp -n prompt_example/voice_tool.md prompt/`。

- **`config/static/bot.json`**（[サンプル](../../config_example/static/bot.json)）
  - `bot_token`、`super_admin_user_id`、および任意の `atmosphere` と `time_zone` を宣言します。起動前に厳格に検証され、未知のキーや不正な型は起動を拒否します。

- **`config/dynamic/stickers.json`**（[サンプル](../../config_example/dynamic/stickers.json)）
  - AI が使用可能なスタンプパック名配列を宣言します（最大 5 個）。

- **`config/dynamic/mood.json`**（[サンプル](../../config_example/dynamic/mood.json)）
  - AI のムード段階（名前、説明、重み、天気・時間帯倍率）を宣言します。重みは正の整数であり、合計が厳格に 100 と一致する必要があります。

- **`config/dynamic/ad_samples.json`**（[サンプル](../../config_example/dynamic/ad_samples.json)）
  - 広告検出モデルの判定用参照サンプルを宣言します。空でない文字列配列で重複不可、最大 500 件です。

- **`config/dynamic/agent.json`**（[サンプル](../../config_example/dynamic/agent.json)）
  - AI システムの 7 大能力を宣言します。各能力は独立して設定され、能力間で自動フォールバックすることは決してありません：
    1. **対話コア必須能力**（3 つのいずれかが欠けると AI チャットは利用不可）：
       - `text`：テキスト生成モデル。
       - `summary`：記憶圧縮要約モデル。
       - `media`：画像・音声の文字起こしモデル。マルチモーダルの初回リクエストプローブおよびエンドポイントバックオフに対応。
    2. **拡張生成能力**（未設定時は対応するツールのみ除外）：
       - `image`：画像生成能力。OpenAI 互換プロトコルでは `image_protocol`（`openai` | `openai-standard` | `xai`）を明示宣言する必要があります。
       - `tts`：音声合成能力。`voice` 音色の指定が必須です。OpenAI は `speech_protocol`（`openai` | `xai`）の宣言が必要です。任意の `bot_language`（`en` | `zh` | `ja`、既定 `ja`）で AI ボイスのセリフの言語を指定します（`send_voice` のツール説明は `prompt/voice_tool.md` で全体を置き換え可能）。`bot_language` はモデル向けのプロンプトを切り替え、AI 返信の合成リクエストでは基本スタイルの後ろにその言語の読み上げ言語指定を追加します（`/send` と cron の合成には追加しません）。`style` と `prompt/voice_tool.md` は追従しません。`style` は `/send` と cron でも使うため声質だけを書き、読み上げ言語は書きません。`bot_language` を変えるときは、その言語で書いた声質説明に替えることを推奨します（省略時の `TTS_DEFAULT_STYLE` は日本語の説明）。`voice_tool.md` を配置している場合は、そのセリフの言語と例も同じ言語に変えてください。任意の `daily_limit`（既定 100）および `daily_reserve_quota`（既定 25、`/send` と cron に配分）を設定可能です。
    3. **検索とリスク管理能力**：
       - `web_search`：ローカル Web 検索ツール能力。1 ターンあたりの呼び出し回数を制限する `max_calls_per_use`（既定 5）に対応。未設定時は `text` モデルのサーバー内蔵検索へフォールバックします。
       - `ad_detect`：グループ参加時のメッセージ広告識別能力。未設定時は広告検出をブロックします。
    4. **各能力共通フィールド**：
       - `provider`：`google` | `openai` | `anthropic`（`image` と `tts` は前 2 者のみ対応）。
       - `api_key`：アクセスキー。
       - `model`：モデル識別子文字列。
       - `base_url`：任意のカスタムエンドポイント（`https` のみ。平文 `http` は localhost/127.0.0.1/::1 のみ許可）。
       - `headers`：`google` provider のみ追加の HTTP リクエストヘッダー（1〜8 個、Cloudflare AI Gateway などのサードパーティゲートウェイ認証用）を設定可能。

---

### identity storage の初期化

実行時はテーブルの自動作成を行わないため、初回デプロイ時は手動またはスクリプトで SQLite データベースを初期化する必要があります：

```bash
mkdir -p database
bun -e '
  import { createStorageDatabase } from "./packages/database/interact/migration";
  import {
    closeStorageDatabase,
    enableStorageDatabaseWal,
    openStorageDatabase,
  } from "./packages/database/interact/connection";
  import { initializeStorageDatabase } from "./packages/database/interact/initialization";
  import { loadBotConfig } from "./packages/config/botInput";
  import { IDENTITY_DATABASE_PATH } from "./packages/consts/paths";

  const { timeZone } = await loadBotConfig();
  createStorageDatabase(IDENTITY_DATABASE_PATH);
  const database = openStorageDatabase({ path: IDENTITY_DATABASE_PATH });
  try {
    initializeStorageDatabase(database, timeZone);
  } finally {
    closeStorageDatabase(database);
  }
  enableStorageDatabaseWal(IDENTITY_DATABASE_PATH);
'
chmod 2770 database
chmod 660 database/storage.sqlite
```

> [!IMPORTANT]
> `initializeStorageDatabase` は必須です。`storage_metadata` にスキーマバージョン番号と `bot.json` の `time_zone`（データルートを固定するタイムゾーンマーカー）を書き込むため、Telegram の識別情報を設定した後に実行します。この手順をスキップすると、起動時の hydrate でメタデータが見つからず直ちに終了します。

---

### インラインサムネイルと Bot 既定アバターの差し替え

`config/dynamic/assets.json`（ホットリロード対応）を通じて、UI 素材や画像ライブラリディレクトリをカスタマイズできます：

```json
{
  "onlyPath": {
    "random_h_image_dir": "./h_image"
  },
  "pathOrUrl": {
    "bot_default_avatar": "https://example.com/avatar.png"
  },
  "onlyUrl": {
    "fortune_thumbnail_url": "https://example.com/fortune.png",
    "probability_thumbnail_url": "https://example.com/probability.png",
    "gag_thumbnail_url": "https://example.com/gag.png"
  }
}
```

- **`onlyPath`**：ローカル絶対パスまたは `./` / `../` 相対パス（データルート基準で解決）のみを受け付けます。`random_h_image_dir` は `/h_image` 専用の画像ライブラリです。
- **`pathOrUrl`**：ローカルパスまたは HTTPS/HTTP 直リンク。`bot_default_avatar` はデフォルトアバターを復元する際に使用する画像です。
- **`onlyUrl`**：画像バイトを直接出力可能な `https://` 絶対 URL である必要があります。おみくじ、確率論、および gag 発言入口のサムネイル画像です。

---

## Telegram 側の設定（BotFather とグループ内）

[@BotFather](https://t.me/BotFather) で以下の設定を行います：

1. **Privacy Mode を無効化**：`/setprivacy` を実行 -> 対象の Bot を選択 -> **Disable** に設定。
   - *理由*：無効化しない場合、Bot はグループ内の一般メッセージを受信できず、リピート、AI チャット、自動リスク管理が一切動作しません。
2. **管理者権限を付与**：Bot を対象グループに追加し、グループ管理者権限（メッセージ削除、メンバーの BAN、グループ管理など）を付与します。
3. **Inline Mode を有効化**：`/setinline` を実行 -> **Enable** に設定。
   - *理由*：おみくじ（`@Bot 占いたい内容`）および gag 発言制限はインラインモードに依存します。
4. **Inline フィードバック率を設定**：`/setinlinefeedback` を実行 -> **100%** に設定。
   - *理由*：`chosen_inline_result` はおみくじ結果の確定と永続化を行う中核経路です。
5. **（任意）Bot-to-Bot 通信を有効化**：他の Bot の通常メッセージをリピートまたは翻訳する場合は、BotFather でこのモードを有効にします。届いたメッセージは [main thread の入口制限](04-invariants.md)を通ります。

---

## 初回起動

```bash
# 1. 品質ゲートを実行して環境が正常であることを確認
bun run check

# 2. ロングポーリングサービスを起動
bun run start
```

サービス起動後、**スーパー管理者**が対象グループ内で以下のコマンドを送信してハンドシェイクを完了します：

```text
/init enable      # 本グループの業務入口を有効化（最初に必ず実行してください。未有効化のグループのメッセージは破棄されます）
/ai_chat enable   # （任意）本グループの AI チャットを有効化
/ad_detect enable # （任意）本グループの広告検出を有効化（管理者権限が必要）
/antiraid enable  # （任意）本グループの参加認証および荒らし防止プライベートモードを有効化（管理者権限が必要）
```

### 動作確認

- グループ内で `/copy` を送信（誰かのメッセージに返信）：Bot が正常にリピートを開始し、そのユーザーのアバターと同期することを確認します。
- `logs/` ディレクトリを確認：実行ログファイルが正常に生成されていることを確認します。
- `Ctrl+C` で終了：コンソール上で入口の遮断、Worker キューのフラッシュ、状態の永続化が完了し、グレースフルシャットダウンが円滑に行われることを確認します。

---

<div align="center">

**← 前のページ：なし** · [📚 開発者ドキュメント TOP](content-table.md) · [⬆️ トップへ戻る](#01-環境構築と初回起動) · [次のページ：02 アーキテクチャ概要 →](02-architecture.md)

</div>
