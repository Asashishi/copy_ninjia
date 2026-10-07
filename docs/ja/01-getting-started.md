# 01 環境構築と初回起動

<p align="center">
  <a href="../cn/01-getting-started.md">简体中文</a> · <a href="../en/01-getting-started.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 開発者ドキュメント TOP</a> · <b>← 前のページ：なし</b> · <a href="02-architecture.md">次のページ：02 アーキテクチャ概要 →</a>
</p>

---

このガイドでは、クリーンな環境から Bot をセットアップし、グループ内で正常稼働させるまでの最短手順を解説します。システム全体の構成やメッセージフローについては、[02 アーキテクチャ概要](02-architecture.md) を参照してください。

## 前提条件

- **`/proc` にアクセス可能な Linux 環境**：インスタンスの二重起動防止ロックは、`/proc/<pid>/stat` とシステムの boot ID に依存しています。その他の OS では安全のため起動を拒否（fail-closed）します。
- **Bun 1.4.2**：ソースコードからの実行およびローカル開発に必須です。次のコマンドでインストールできます：
  ```bash
  curl -fsSL https://bun.sh/install | bash -s bun-v1.4.2
  ```
  > [!NOTE]
  > バイナリ配布版には内蔵ランタイムが同梱されているため、ホストマシンへの Bun のインストールは不要です。なお、プロジェクト全体を通じて Node.js は一切使用しません。
- **Telegram Bot Token**：[@BotFather](https://t.me/BotFather) で `/newbot` を実行して Bot を作成し、Token を取得します。
- **各 AI 機能の API キー**：`config/dynamic/agent.json` で有効化する機能（会話、メディア認識、画像生成、音声合成、Web 検索など）ごとに、API キー、プロバイダ、エンドポイント、モデル名を設定します。[Google AI Studio](https://aistudio.google.com/)、[OpenAI Platform](https://platform.openai.com/) などの互換プロバイダから取得してください。機能間での自動フォールバックは行われません。
- **Google Cloud サービスアカウント JSON（任意）**：`/translate` 翻訳機能を利用する場合にのみ必要です。`config/static/g-auth.json` として配置します（フォーマットは [サンプル](../../config_example/static/g-auth.json) を参照してください。サンプルのプレースホルダー秘密鍵のままではパーサーによって拒否されます）。
  - **認証情報仕様**：`packages/config/googleAuth.ts` が厳格に検証します。`client_email` と、RS256 署名用の空でない RSA PEM 秘密鍵（EC、Ed25519、RSA-PSS 鍵は拒否）が必須です。`type` は省略可能ですが、指定する場合は `service_account` のみ受け付けます。
  - **省略時の動作**：認証ファイルが存在しなくてもプロセスの起動自体は妨げられません。`/translate` コマンドが実行された際にのみ、ファイルが見つからない旨を返して実行を拒否します。ただし、ファイルが存在するにもかかわらずフォーマットが不正な場合は、起動時の全体検証ゲートにより直ちに終了します。
  - **認証情報の読み込み**：起動時にプロセスレベルの読み取り専用スナップショットが作成され、実行中にディスクから再読み込みされることはありません。エラーメッセージにはファイルパスと期待されるフィールド形式のみが出力され、認証情報そのものは一切ログ出力されません。

---

## インストール

### ワンショットインストール

新規サーバーへの導入には、自動化スクリプト [`install.sh`](../../install.sh) の利用を推奨します：

```bash
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash
```

インストールモードは、引数または環境変数 `COPY_NINJIA_INSTALL_MODE`（`source` または `binary`）で指定できます（両方の同時指定は不可）。未指定の場合は、対話式プロンプトで確認されます（デフォルトは `source`）。`COPY_NINJIA_DIR` でインストール先ディレクトリ名を指定できます（デフォルトは `copy_ninjia`）。

```bash
# バイナリ配布版のインストール（素早いデプロイに推奨、git や Bun の事前導入は不要）
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash -s -- --binary

# ソースコード版のインストール（二次開発やカスタマイズに適しています）
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
    <td><nobr>📦 <b>配布形式</b></nobr></td>
    <td>GitHub Latest Release からプラットフォーム適合パッケージを自動取得</td>
    <td>対応する Release タグを <code>git clone</code>（detached HEAD）</td>
  </tr>
  <tr>
    <td><nobr>⚙️ <b>依存要件</b></nobr></td>
    <td>ホストの Bun、git、ビルドツールは不要。展開に必要な基本コマンドが不足していればインストーラーが導入を試行</td>
    <td>git および Bun 1.4.2 が必要。不足ツールはインストーラーが導入を試行しますが、Bun バージョンの不整合は手動解決が必要</td>
  </tr>
  <tr>
    <td><nobr>🚀 <b>ランタイム構成</b></nobr></td>
    <td>Bun ランタイムと Worker 群を内蔵した単一の実行可能バイナリ</td>
    <td><code>bun install --frozen-lockfile</code> による依存関係解決（<code>bunfig.toml</code> の冷却期間ポリシーに準拠）</td>
  </tr>
  <tr>
    <td><nobr>▶️ <b>起動コマンド</b></nobr></td>
    <td>展開された実行ファイル <code>./copy-ninjia</code> を直接実行</td>
    <td><code>bun run start</code> または <code>bun run index.ts</code> を実行</td>
  </tr>
</tbody>
</table>

> [!TIP]
> **インストーラーの実行フロー概要**（`install.sh` の進捗表示と対応。サービスとバックアップの境界については [07 運用](07-operations.md#インストーラーのサービスとバックアップ境界) を参照）：
> 1. **プラットフォーム検証**：Linux 環境、読み取り可能な `/proc`、および対話型端末（`/dev/tty`）の存在を確認します。
> 2. **リポジトリおよびバイナリの取得**：スクリプト実行元、カレントディレクトリ、対象ディレクトリの順に既存環境を探索します。存在しない場合は最新 Release タグのソースをクローンするか、プラットフォーム（x64/arm64、glibc/musl）に合致するバイナリをダウンロードしてハッシュを検証します。
> 3. **ツールチェーンと Bun の準備**：ソースモードでは必要に応じて指定バージョンの Bun（`package.json` の `packageManager` と一致）をセットアップします。バイナリモードでは内蔵バイナリを使用します。
> 4. **依存関係のインストール**：ソースモードでは `bun install --frozen-lockfile` を実行し、バイナリモードではスキップします。
> 5. **設定ディレクトリの構造化**：誤った位置にあるファイルや旧バージョンのグローバル状態・データベースを検知した場合は起動を阻止します。不足している設定テンプレートのみを展開し、`agent.json`、`g-auth.json`、`cron.json` は手動設定に委ねます（既存ファイルは上書きしません）。
> 6. **対話型設定ウィザード**：端末上で `config/static/bot.json` の必須項目を案内し、`config/dynamic/agent.json` が未作成の場合は各 AI 機能の設定をステップ形式で入力します。既存設定を変更する場合はワークツリー外に自動バックアップを取り、厳格なバリデーションを通過した時点で安全にアトミック置換します。
> 7. **データベース初期化**：`database/storage.sqlite` を検証します。既存データベースが存在する場合は設定されたタイムゾーンが `bot.json` の `time_zone` と一致することを読み取り専用で照合します（不一致の場合はサービス登録前に停止）。新規の場合は現行スキーマでデータベースを初期化し、タイムゾーンマーカーを書き込みます。
> 8. **サービス登録と稼働監視**：`copy-ninjia.service` を systemd に登録・起動します（systemd が利用できないコンテナ環境等ではフォアグラウンド実行）。起動直後のステータスを監視し、`active/running` 状態、再起動ループの非発生、およびログに異常終了がないことを確認した上で一時バックアップをクリーンアップします。

### ソースからの手動インストール

```bash
# 1. リポジトリをクローン
git clone https://github.com/Asashishi/copy_ninjia.git
cd copy_ninjia

# 2. ロックファイルに従って依存関係を厳格にインストール
bun install --frozen-lockfile

# 3. 設定ファイル用ディレクトリを作成してサンプルを展開
mkdir -p config/static config/dynamic
for example in config_example/static/*.json config_example/dynamic/*.json; do
  case "${example##*/}" in
    g-auth.json | cron.json) ;;
    *) cp -n "$example" "config/${example#config_example/}" ;;
  esac
done
```

> [!WARNING]
> `g-auth.json` と `cron.json` のサンプルは記法リファレンス用であり、本番ディレクトリへ自動コピーしないでください。コピーした各設定内の `replace-with-…` プレースホルダー（`bot_token` や各 AI 機能の `api_key`）は必ず実際の値に置き換えてください。プレースホルダーが残ったままでは起動時バリデーションでエラー終了します。詳細は [`config_example/README/ja.md`](../../config_example/README/ja.md) を参照してください。

---

## Telegram identity の設定

Bot の基本設定およびグローバルスーパー管理者は `config/static/bot.json` で定義します：

- **`bot_token`**（必須、文字列）
  - BotFather から発行された Telegram Bot API Token。サンプル内のプレースホルダー文字列は拒否されます。
- **`super_admin_user_id`**（必須、正の整数）
  - スーパー管理者の Telegram ユーザー ID（10進数値）。
  - **特権スコープ**：この ID はホワイトリストで管理される**すべての権限**を最初から保有しており、SQLite のホワイトリストテーブルには登録されません。
  - **保護ポリシー**：リピートや画像生成などのクールダウン免除はこの ID のみに付与されます。常にホワイトリストの内側に保護されているため、自動リスク管理の対象外となり、`/block`、`/mute`、`/batch_kick` で処分することはできません。
  - **専用コマンド**：`/init`、`/batch_kick`、`/permission` による権限変更、`/white disable`、`/send` の実行はスーパー管理者のみに許可されています。
- **`atmosphere`**（任意、列挙型：`"mesugaki"` | `"normal"`）
  - システム通知やメニュー表示のトーンスタイル（メスガキ風 / 標準）。
  - 明示的に指定した値が最優先されます。省略時は `prompt/persona.md` が存在すれば標準、存在しなければメスガキ風が適用されます。前後の空白はトリムして検証され、不正な値は起動を拒否します。
- **`time_zone`**（任意、IANA タイムゾーン名。省略時は `DEFAULT_BOT_TIME_ZONE`。ホストのローカルタイムゾーンは継承しません）
  - おみくじ日付境界、ログ出力、広告判定の発言カウント、AI 時刻認識、日次クリーンアップ、タイムゾーン省略時の cron スケジュール基準となるタイムゾーンです。
  - 前後の空白をトリムして検証され、Temporal 仕様に基づいて正規化されます（例：`asia/tokyo` → `Asia/Tokyo`、`Japan` などのエイリアスも保持）。空文字列、不正な型、あるいは Temporal / Bun cron が認識できないタイムゾーンは起動を拒否します。
  - 初回データベース初期化時に `storage_metadata` の `time-zone` に記録され、以降そのデータルートは該当タイムゾーンに固定されます。起動時およびインストーラーは常にこの値を検証し、タイムゾーンの変更は許可されません（変更検知時は `storage_metadata.time-zone` エラーで起動を阻止します）。既存データルートに対するタイムゾーンの事後変更はサポートしていません。

---

## プロジェクト側の設定ファイル

`config/` ディレクトリはデプロイ固有のプライベートデータであり、`.gitignore` で Git 管理から完全に除外されています。ファイルのレイアウトは以下のサブディレクトリ構造を厳格に維持する必要があります：

```text
config/
├── static/                 # 静的設定（変更反映にはプロセスの再起動が必要）
│   ├── bot.json            # Bot identity とスーパー管理者設定
│   └── g-auth.json         # Google Cloud サービスアカウント認証情報（任意）
└── dynamic/                # 動的設定（変更検知時にデバウンスを挟んで自動ホットリロード）
    ├── agent.json          # AI モデル・各機能設定
    ├── assets.json         # サムネイル、デフォルトアバター、画像ライブラリパス
    ├── stickers.json       # スタンプパックの許可リスト
    ├── mood.json           # ムード段階と重み配分
    ├── ad_samples.json     # 広告判定用の参照サンプル集
    └── cron.json           # 定期実行タスク定義（任意）
```

> [!IMPORTANT]
> - 設定ファイルが `config/` の直下に置かれていたり、誤ったサブディレクトリに配置されている場合、システムは起動時に fail-closed で直ちに終了します。
> - 稼働中に `config/dynamic/` 配下のファイルを編集すると、デバウンス処理を経て自動的にホットリロードされます。変更後の内容に構文エラーやスキーマ違反が含まれる場合、その回の更新全体が安全にロールバック（直前の正常スナップショットを維持）され、エラーログが記録されます。次回の再起動時までに修正されなければ起動を拒否します。

### コア設定ファイルの詳細

- **`prompt/persona.md`**（任意、プロジェクトルート。[例](../../prompt_example/persona.md)）
  - **役割**：カスタム AI 会話ペルソナ。
  - **挙動**：ファイルが存在しない場合は、内蔵のペルソナ定義（[`persona.ts`](../../packages/consts/aiChat/prompts/persona.ts)）が使用されます。ファイルが存在する場合は、その全文がシステムプロンプトのペルソナとして適用されます。通知メッセージのトーン設定については上記の `atmosphere` を参照してください。
  - **検証**：プレーンテキスト形式。ファイルが存在していても空ファイルや不正な UTF-8 である場合は起動を拒否します。変更の反映にはプロセスの再起動が必要です。
  - **記述例**：[`prompt_example/persona.md`](../../prompt_example/persona.md) は、穏やかで頼れる「先輩」を想定したペルソナ構成例です。「自己定義 / 基本性格 / 優先順位 / 口調・スタイル / ハルシネーションの防止 / 言語規範」のセクションに分かれています。`mkdir -p prompt && cp -n prompt_example/persona.md prompt/` でコピーし、必要に応じて編集したのちプロセスを再起動してください。ファイル内の文章は前後の空白を除いてそのままモデルに送信されるため、管理者向けの内部メモ等は記述しないでください。

- **`prompt/voice_tool.md`**（任意、プロジェクトルート。[例](../../prompt_example/voice_tool.md)）
  - **役割**：AI の音声送信ツール `send_voice` のカスタム説明文。
  - **挙動**：ファイルが存在しない場合は、`agent.tts.bot_language` に応じた内蔵の `en` / `zh` / `ja` 説明（[`tools.ts`](../../packages/consts/aiChat/prompts/tools.ts) の `VOICE_LANGUAGE_PROMPTS`）が使用されます。ファイルが存在する場合は、`bot_language` の設定にかかわらず、ファイル本文がツールの説明全体を置き換えます。ただし、`text` / `tone` 引数の詳細仕様や、`send_message` および「行動と停止」ルールにおけるボイス重複制御は、引き続き `bot_language` の値に基づいて制御されます。内蔵プロンプトに含まれる実行契約（現在のターンにおける `send_voice` 残りクォータの確認、1 ターンあたりの送信上限件数、`text` / `tone` の最大文字数、受領・エラー時の対応指針）は、カスタムファイル内でも漏れなく記述する必要があります。
  - **検証**：プレーンテキスト形式。ファイルが存在しながら空文字または不正な UTF-8 である場合は起動を拒否します（`agent.tts` が未設定の場合でも同様に検証されます）。変更反映には再起動が必要です。
  - **記述例**：[`prompt_example/voice_tool.md`](../../prompt_example/voice_tool.md) は前述のペルソナ例と対になっており、自然な日本語のセリフ例とともに必要な制約事項をすべて網羅しています。例に記載されている 1 ターンあたりの上限件数や文字数制限はコード内の定数値と完全に一致させてあるため、編集時も定数値と整合させてください。このサンプルは `bot_language: "ja"`（[`agent.json` サンプル](../../config_example/dynamic/agent.json)）向けに作成されています。別の言語を使用する場合は、冒頭の言語指定、セリフ例、トーン指定、重複説明を該当言語に合わせて変更してください。配置手順は同様です：`mkdir -p prompt && cp -n prompt_example/voice_tool.md prompt/`。

- **`config/static/bot.json`**（[サンプル](../../config_example/static/bot.json)）
  - 設定項目は前述の「Telegram identity の設定」を参照してください。起動時に厳格な型検証が行われ、未知のキーや不正な型の値が含まれる場合は起動を拒否します。

- **`config/dynamic/stickers.json`**（[サンプル](../../config_example/dynamic/stickers.json)）
  - AI が送信可能なスタンプパックの short name 配列 `packs` を定義します。各要素は有効な Telegram スタンプパックの識別名で重複不可、登録可能数は最大 `MAX_CONFIGURED_STICKER_PACKS` 個です。

- **`config/dynamic/mood.json`**（[サンプル](../../config_example/dynamic/mood.json)）
  - AI の感情ステータス配列 `moods` を定義します。各項目は `name`、`weight`、`instruction` を含み、必要に応じて `weatherMultipliers` や `timeMultipliers` を設定できます。名前の重複は不可、重みは正の整数であり、全要素の合計値が厳密に `MOOD_WEIGHT_TOTAL` と一致する必要があります。

- **`config/dynamic/ad_samples.json`**（[サンプル](../../config_example/dynamic/ad_samples.json)）
  - 広告検出モデルの判定用参照サンプル文字列配列を定義します。空白文字の正規化とトリムが行われた上で、各項目は空文字不可、最大 `AD_SAMPLE_MAX_CHARS` 文字以内、重複不可、最大 `MAX_CONFIGURED_AD_SAMPLES` 件まで登録可能です。

- **`config/dynamic/agent.json`**（[サンプル](../../config_example/dynamic/agent.json)）
  - AI システムの各機能を定義します。トップレベルキーは `agent` のみです。各機能は独立して設定され、機能間での自動フォールバックは行われません。未知のキーが存在する場合は起動を拒否します：
    1. **会話コア必須機能**（いずれか 1 つでも欠落している場合、AI チャット全体が無効化されます）：
       - `text`：テキスト生成用メインモデル。
       - `summary`：短期・長期コンテキストの要約圧縮モデル。
       - `media`：画像・音声の文字起こしおよびマルチモーダル認識モデル。初回リクエストの自動プローブとエンドポイントの指数バックオフに対応。
    2. **拡張生成機能**（未設定時は該当ツールのみが無効化されます）：
       - `image`：画像生成機能。OpenAI 互換プロトコルでは `image_protocol`（`openai` | `openai-standard` | `xai`）の明示指定が必要です（Google プロバイダではこのフィールドを指定できません）。
       - `tts`：音声合成機能。`voice`（声色）の指定が必須です。OpenAI プロトコルでは `speech_protocol`（`openai` | `xai`）の指定が必要です（Google プロバイダでは指定不可）。任意の `style`（デフォルトの声質定義。省略時は `TTS_DEFAULT_STYLE`。`/send` や cron からも共用されるため、言語名ではなく声質のみを記述します）を指定できます。`xai` プロトコルはモデル名やスタイル指示をサポートしないため、`model` または `style` を指定するとエラーになります。また任意の `language` も指定可能です。
         - `bot_language`（`en` | `zh` | `ja`。省略時は `TTS_DEFAULT_BOT_LANGUAGE`）：AI 音声のセリフ言語を指定します。システムプロンプトが切り替わり、AI 返信の合成リクエスト時に基本スタイルの末尾へ言語指定が自動付与されます（`/send` や cron 経由の合成には付与されません）。なお、`style` および `prompt/voice_tool.md` は自動追従しないため、`bot_language` を変更する際は手動で対応言語の内容に書き換えてください。
         - `daily_limit`（省略時は `TTS_DEFAULT_DAILY_LIMIT`）および `daily_reserve_quota`（省略時は `TTS_DEFAULT_DAILY_RESERVE_QUOTA`。`daily_limit` 未満である必要があります）：1 日あたりの合成回数クォータを AI 返信用と `/send`・cron 共用の予約枠に分割し、それぞれ独立して消費をカウントします。
    3. **検索および安全管理機能**：
       - `web_search`：ローカル Web 検索ツール機能。`max_calls_per_use`（正の整数。省略時は `WEB_SEARCH_DEFAULT_MAX_CALLS_PER_USE`）で 1 ターンあたりの最大呼び出し回数を制限できます。未設定時は `text` モデル内蔵のグラウンディング検索が使用されます。
       - `ad_detect`：新規メンバー参加時のスパム・広告検出機能。未設定時は広告検出が無効化されます。
    4. **各機能の共通フィールド**：
       - `provider`：`google` | `openai` | `anthropic`（`image` と `tts` は Google と OpenAI のみ対応）。
       - `api_key`：アクセスキー。サンプル内のプレースホルダー文字列は拒否されます。
       - `model`：モデル識別子文字列。
       - `base_url`：カスタムエンドポイント（`https` のみ。プレーン `http` は localhost / 127.0.0.1 / ::1 のみ許可。userinfo や `#` フラグメントは不可）。
       - `headers`：`google` プロバイダのみ、追加のリクエストヘッダー（1〜`AGENT_HEADERS_MAX_ENTRIES` 個。Cloudflare AI Gateway 等の認証用）を設定可能。

---

### identity storage の初期化

本システムは起動時にテーブルの自動マイグレーションを行いません。初回デプロイ時は、スクリプトを使用して手動で SQLite データベースを初期化する必要があります：

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
> `initializeStorageDatabase` の実行は必須です。この初期化処理により、`storage_metadata` にスキーマバージョンおよび `bot.json` の `time_zone`（データルートを束縛するタイムゾーンマーカー）が書き込まれます。そのため、必ず Telegram identity の設定完了後に実行してください。この手順をスキップすると、起動時のハイドレーション処理でメタデータが見つからず起動に失敗します。

---

### インラインサムネイルと Bot 既定アバターの差し替え

`config/dynamic/assets.json`（ホットリロード対応）を通じて、各種 UI アセットや画像ライブラリパスをカスタマイズできます：

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

ファイル自体、各カテゴリブロック、および内部の各フィールドはすべて任意であり、省略された場合は内蔵の既定アセットが使用されます。ただし、指定された値が不正な場合や、未知のキーが含まれている場合は設定ファイル全体が拒否されます。

- **`onlyPath`**：ローカルの絶対パスまたは `./` / `../` 相対パス（データルート基準）のみを受け付けます。`random_h_image_dir` はランダム画像ライブラリのディレクトリであり、`/h_image` コマンドや `cron.json` の `send_image`（ディレクトリ未指定時）で使用されます。
- **`pathOrUrl`**：ローカルファイルパスまたは HTTP(S) の直リンク。`bot_default_avatar` は Bot のデフォルトアバター復元時に使用される画像です。ローカルファイルを指定する場合、JPEG または PNG 形式の通常ファイルで、サイズは `AVATAR_MAX_DOWNLOAD_BYTES` 以下である必要があります。
- **`onlyUrl`**：画像バイナリを直接取得可能な `https://` 絶対 URL である必要があります。おみくじ（`/fortune`）、確率判定（`/probability`）、および gag 発言入口のインラインサムネイル画像として使用されます。

---

## Telegram 側の設定（BotFather とグループ内）

[@BotFather](https://t.me/BotFather) で以下の初期設定を行います：

1. **Privacy Mode を無効化**：`/setprivacy` を送信 -> 対象の Bot を選択 -> **Disable** に設定。
   - *目的*：Bot がグループ内のすべての通常メッセージを受信できるようにします。リピート、会話認識、自動リスク管理に必須です。
2. **グループ管理者権限の付与**：Bot を対象グループに追加し、管理者権限（メッセージ削除、ユーザーの BAN / 制限、グループ管理など）を付与します。
3. **Inline Mode の有効化**：`/setinline` を送信 -> **Enable** に設定。
   - *目的*：おみくじ機能（`@Bot 占いたい内容`）および gag 発言制限の入力処理にインラインモードを使用します。
4. **Inline フィードバック率の設定**：`/setinlinefeedback` を送信 -> **100%** に設定。
   - *目的*：おみくじ結果の確定と永続化のために、Telegram からの `chosen_inline_result` イベント通知が必要です。
5. **Bot 間通信の有効化（任意）**：他の Bot による通常メッセージに対してもリピートや翻訳を動作させたい場合は、BotFather でこのモードを有効にします。受信したメッセージは [メインスレッドの受信境界](04-invariants.md) を通じて安全に処理されます。

---

## 初回起動

```bash
# 1. 総合品質ゲートを実行して環境と設定の整合性を確認
bun run check

# 2. ロングポーリングサービスを起動
bun run start
```

サービス起動後、**スーパー管理者**が対象グループ内で以下のコマンドを送信してグループの初期化を完了します：

```text
/init enable      # グループの業務受付を有効化（最優先で実行。未有効化グループのメッセージはすべて破棄されます）
/ai_chat enable   # （任意）該当グループでの AI 会話を有効化
/ad_detect enable # （任意）該当グループでの広告検出を有効化（要管理者権限）
/antiraid enable  # （任意）該当グループでの参加認証およびスパム防御（ロックダウン）を有効化（要管理者権限）
```

### 動作確認

- グループ内で誰かのメッセージに返信して `/copy` を送信：Bot がメッセージのリピートを開始し、対象ユーザーのアバターと同期することを確認します。
- `logs/` ディレクトリを確認：実行ログが正常に出力されていることを確認します。
- `Ctrl+C` による終了テスト：コンソール上で受付遮断、Worker キューのフラッシュ、状態の永続化が順序通り実行され、安全にグレースフルシャットダウンすることを確認します。

---

<div align="center">

**← 前のページ：なし** · [📚 開発者ドキュメント TOP](content-table.md) · [⬆️ トップへ戻る](#01-環境構築と初回起動) · [次のページ：02 アーキテクチャ概要 →](02-architecture.md)

</div>

