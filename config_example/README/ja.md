[中文](zh.md) / [English](en.md) / [日本語](ja.md)

# デプロイ設定リファレンス

このディレクトリには、Git にコミットできる構造例のみを保存しています。Bot が実際に読み込むのはプロジェクトルートにある Git 対象外の `config/` ディレクトリです。サンプル内の token、API key、ユーザー ID、モデル名、エンドポイントは実際のデプロイ環境に合わせて入力してください。**サンプルの設定値のまま本番環境で使用することはできません**。

初回デプロイ時は、存在しない JSON ファイルのみをコピーしてください。`g-auth.json` のサンプルは構造のみを示し、`cron.json` のサンプルは書き方を示すためのものであるため、これらは直接コピーしないでください：

```bash
mkdir -p config/static config/dynamic
for example in config_example/static/*.json config_example/dynamic/*.json; do
  case "${example##*/}" in
    g-auth.json | cron.json) ;;
    *) cp -n "$example" "config/${example#config_example/}" ;;
  esac
done
```

> [!CAUTION]
> 既存のファイルを上書きするコピーコマンドを使用しないでください。また、`config_example/` をデプロイ設定のバックアップとして扱わないでください。`config/` には機密情報が含まれるため、サービスアカウントのみに読み取り権限を付与することを推奨します。

`config/` は設定の反映方法に応じて厳格に 2 つのサブディレクトリに分かれています：
- `config/static/`：`bot.json`、`g-auth.json`。変更後は**サービスの再起動が必要**です。
- `config/dynamic/`：`assets.json`、`ad_samples.json`、`agent.json`、`mood.json`、`stickers.json`、`cron.json`。稼働中の変更は自動的にホットリロードされます。

`config/dynamic/` ディレクトリは必ず存在させてください（空でも構いません）。設定ファイルが `config/` 直下に置かれていたり、誤ったサブディレクトリに置かれている場合は起動を拒否します。ホワイトリスト、ブラックリスト、およびグループ状態は `database/storage.sqlite` に保存されるため、設定ファイルではありません。

すべての JSON ファイルに対して厳格なスキーマ検証が行われます。未知のフィールド、誤字、型の不一致、不正な列挙値、範囲外の値がある場合、起動時またはホットリロード時に即座に拒否され、**自動修復や無視は一切行われません**。

---

## 設定ファイル一覧

<table width="100%">
<thead>
  <tr>
    <th width="22%" align="left">設定ファイル</th>
    <th width="18%" align="left">ライフサイクル</th>
    <th width="34%" align="left">主な設定内容</th>
    <th width="26%" align="left">欠落時の動作</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><code>static/bot.json</code></td>
    <td><nobr>静的（再起動が必要）</nobr></td>
    <td>Telegram Bot Token、唯一のスーパー管理者、既定の口調とタイムゾーン</td>
    <td><b>起動を拒否（致命的エラー）</b></td>
  </tr>
  <tr>
    <td><code>dynamic/agent.json</code></td>
    <td><nobr>動的（ホットリロード）</nobr></td>
    <td>各 AI モデルの呼び出しプロトコル、資格情報、エンドポイント、パラメータ</td>
    <td>中核 3 能力欠落時は AI 雑談停止、オプション欠落時はツール無効化</td>
  </tr>
  <tr>
    <td><code>dynamic/stickers.json</code></td>
    <td><nobr>動的（ホットリロード）</nobr></td>
    <td>AI 雑談で使用可能な Telegram ステッカーパック short name 一覧</td>
    <td>AI 雑談が停止（起動は成功）</td>
  </tr>
  <tr>
    <td><code>dynamic/mood.json</code></td>
    <td><nobr>動的（ホットリロード）</nobr></td>
    <td>AI 気分一覧、基礎抽出ウェイト、環境倍率</td>
    <td>AI 雑談が停止（起動は成功）</td>
  </tr>
  <tr>
    <td><code>dynamic/ad_samples.json</code></td>
    <td><nobr>動的（ホットリロード）</nobr></td>
    <td>広告分類判定用の正例リファレンスサンプル</td>
    <td>広告検出が停止（起動は成功）</td>
  </tr>
  <tr>
    <td><code>dynamic/cron.json</code></td>
    <td><nobr>動的（ホットリロード）</nobr></td>
    <td>定時送信タスク一覧（テキスト・画像・ファイル・音声・ニュース要約）</td>
    <td>定時タスクなし</td>
  </tr>
  <tr>
    <td><code>dynamic/assets.json</code></td>
    <td><nobr>動的（ホットリロード）</nobr></td>
    <td><code>/h_image</code> 専用画像庫パス、既定アバター、インラインサムネイル URL</td>
    <td>組み込みの既定値を使用</td>
  </tr>
  <tr>
    <td><code>static/g-auth.json</code></td>
    <td><nobr>静的（再起動が必要）</nobr></td>
    <td>Google Cloud 翻訳サービスアカウント鍵（RSA PEM）</td>
    <td>翻訳機能が停止（起動は成功）</td>
  </tr>
</tbody>
</table>

> [!NOTE]
> AI 人設は既定で組み込みのメスガキ風人設を使用します。プロジェクトルートにバージョン管理外の `prompt/persona.md` を配置することで上書きできます。AI `send_voice` のツール説明も `prompt/voice_tool.md` で全体を置き換えられ、いずれも再起動後に反映されます。例は [`prompt_example/persona.md`](../../prompt_example/persona.md) と [`prompt_example/voice_tool.md`](../../prompt_example/voice_tool.md) を参照してください。全グループの通知とメニューは明示した `atmosphere` を優先し、省略時はカスタム人設なら通常、内蔵人設ならメスガキ風を使います。

---

## 稼働中の変更（ホットリロード）

Bot は `config/dynamic/` ディレクトリを常時監視しています。ディレクトリで最後のファイルイベントが発生してから `CONFIG_RELOAD_DEBOUNCE_MS` のデバウンス期間を経て、厳格なスキーマ解析とホットリロードが実行されます：

1. **ホット置換**：検証に合格し設定に変更がある場合、即時にスナップショットを更新して各 Worker に配信します。
2. **検証失敗時のフェイルセーフ**：検証に失敗した場合、変更全体が拒否されます。エラー箇所（ファイルパス、フィールドパス、期待される形式）をログに記録し、システムは直前の有効な設定をそのまま維持します。
3. **機能連動**：
   - `ad_samples.json` や `agent.json` の `ad_detect` を追加・削除すると、広告検出が即時に有効化・無効化されます。
   - `agent.json` の対話中核能力（`text` / `summary` / `media`）や `mood.json` / `stickers.json` を追加・削除すると、AI 雑談が自動的に起動・停止します。
   - 任意のツール能力（`image`、`tts`、`web_search`）の変更は即座に反映されます。
4. **設定ファイル間の依存関係検証**：
   - `cron.json` 内の `send_voice` は `agent.tts` に依存します：`tts` が未設定の状態で `send_voice` を含むタスクを追加すると `cron.json` 全体が拒否され、タスク表に `send_voice` が残っている状態で `agent.tts` を削除する `agent.json` の変更も全体が拒否されます。
   - `send_web_digest` も同様に対話中核能力を必須とします。起動時にも同じ照合を行い、`cron.json` より先に `agent.json` を検証し、依存が欠けていれば起動を拒否します。
5. **ステッカーと画像庫**：
   - `stickers.json` に追加された新規パックは直ちに非同期で説明目録の作成を開始します。ホワイトリストから外れたパックは使用されなくなり、そのセットキャッシュと生成済みの目録も破棄されます。
   - `assets.json` の `random_h_image_dir` を変更した際、新しいディレクトリが無効な場合は変更全体が拒否されます。
6. **定時タスクの増分照合**：`cron.json` はタスク名で差分を検出します。未変更のタスクは既存のスケジュールを維持し、変更・削除されたタスクはスケジュールを停止し、処理中の 1 回分は次のアクション・再試行・グループの前で止まり、新規タスクはスケジュールを開始します。

---

## `bot.json`

静的設定ファイル（パス：`config/static/bot.json`）。変更後はサービスの再起動が必要です。

### 設定例

```json
{
  "bot_token": "replace-with-telegram-bot-token",
  "super_admin_user_id": 987654321,
  "atmosphere": "mesugaki",
  "time_zone": "Asia/Tokyo"
}
```

### フィールド説明

| フィールド名 | 型 | 必須/任意 | 制約および値の範囲 | 説明 |
| --- | --- | --- | --- | --- |
| `bot_token` | `string` | **必須** | 非空文字列、プレースホルダー不可 | BotFather が発行した Telegram Bot API Token（`123456:ABC...` 形式）。最も重要な資格情報 |
| `super_admin_user_id` | `number` | **必須** | 正の安全な整数（`> 0`） | 唯一のスーパー管理者の Telegram ユーザー数値 ID（@ユーザー名ではありません）。全権限を本質的に保持します |
| `atmosphere` | `string` | 任意 | `"mesugaki"` または `"normal"`。前後の空白を除いて厳格に検証。省略時はカスタム人設の有無で選択 | システム通知と操作レシートの文体。明示設定を優先（`mesugaki` はメスガキ風、`normal` は通常）。省略時は `prompt/persona.md` があれば通常、なければメスガキ風。AI 人設は変更しない |
| `time_zone` | `string` | 任意 | IANA 名、既定 `"Asia/Tokyo"`。前後の空白を除いて厳格に検証 | 運勢、ログ、広告の発言累計、AI の時刻、日次保守、タイムゾーンを省略した cron の既定暦タイムゾーン。`Asia/Tokyo`（省略時を含む）の場合だけ東京天気ツールを登録。不正値は起動拒否。データルートは作成時にこのタイムゾーンへ固定され、以後の変更は起動時に拒否されます（[07 運用とトラブルシューティング](../../docs/ja/07-operations.md#暦タイムゾーン) を参照） |

---

## `agent.json`

動的設定ファイル（パス：`config/dynamic/agent.json`）。最上位には単一の `agent` オブジェクトのみを含み、ベンダー単位ではなく能力単位で分割されています。

### 能力一覧と依存関係

| 能力名 | 役割 | 機能概要 | 依存条件 |
| --- | --- | --- | --- |
| `text` | **中核必須** | メインの対話応答生成、ツール呼び出しの制御 | `summary`、`media` と同時に存在する必要あり |
| `summary` | **中核必須** | 長期対話記憶の圧縮、ステッカーパックの自然言語要約 | 必須 |
| `media` | **中核必須** | 画像理解、ステッカー画像説明、音声認識文字起こし | 必須（マルチモーダル対応モデル） |
| `ad_detect` | 任意能力 | 広告メッセージの分類。連投ミュートは独立した投稿数ルールで判定 | 欠落時は広告検出のみ停止し、連投制御には影響しない |
| `image` | 任意能力 | AI 画像生成ツールの登録（Grok Imagine、Imagen 等） | 欠落時は画像生成ツールが無効化 |
| `tts` | 任意能力 | AI 音声返答、`/send` 音声代理送信、cron 定時音声合成 | 欠落時は音声ツール無効化。`cron` に `send_voice` がある場合は必須 |
| `web_search` | 任意能力 | 独立した Web 検索ツール（専用モデルによる内蔵検索） | 欠落時は `text` モデル内蔵の検索にフォールバック |

### 完全な設定例

```json
{
  "agent": {
    "ad_detect": {
      "provider": "openai",
      "api_key": "replace-with-deepseek-api-key",
      "base_url": "https://api.deepseek.com",
      "model": "deepseek-v4-flash"
    },
    "text": {
      "provider": "google",
      "api_key": "replace-with-google-api-key",
      "model": "gemini-3.5-flash-lite"
    },
    "summary": {
      "provider": "anthropic",
      "api_key": "replace-with-anthropic-api-key",
      "model": "claude-sonnet-5-5",
      "fallback_model": "claude-sonnet-5"
    },
    "media": {
      "provider": "google",
      "api_key": "replace-with-google-api-key",
      "base_url": "https://gateway.ai.cloudflare.com/v1/your-account-id/your-gateway/google-ai-studio",
      "headers": {
        "cf-aig-authorization": "Bearer <replace-with-cloudflare-ai-gateway-token>"
      },
      "model": "gemini-3.5-flash-lite"
    },
    "image": {
      "provider": "openai",
      "api_key": "replace-with-xai-api-key",
      "base_url": "https://api.x.ai/v1",
      "model": "grok-imagine-image",
      "image_protocol": "xai"
    },
    "tts": {
      "provider": "google",
      "api_key": "replace-with-google-api-key",
      "model": "gemini-3.8-flash-lite-tts",
      "voice": "en-us-nika",
      "style": "いたずらすきそうな音調が高い小悪魔の甘く、弾むようなツンデレ音色",
      "bot_language": "ja",
      "daily_limit": 100,
      "daily_reserve_quota": 25
    },
    "web_search": {
      "provider": "anthropic",
      "api_key": "replace-with-anthropic-api-key",
      "model": "claude-sonnet-5-5",
      "fallback_model": "claude-sonnet-5",
      "max_calls_per_use": 5
    }
  }
}
```

### 共通フィールド説明

すべての能力（`text`、`summary`、`media`、`ad_detect`、`image`、`tts`、`web_search`）に適用されます：

| フィールド名 | 型 | 必須/任意 | 制約および値の範囲 | 説明 |
| --- | --- | --- | --- | --- |
| `provider` | `string` | **必須** | `"google"`、`"openai"`、または `"anthropic"` | 呼び出しプロトコルおよび SDK 種別（**注意**：`image` と `tts` は `"google"` または `"openai"` のみサポート）。OpenAI 互換サービス（DeepSeek、xAI 等）は `"openai"` を指定 |
| `api_key` | `string` | **必須** | 非空文字列、プレースホルダー不可 | 当該能力専用の API キー |
| `base_url` | `string` | 任意 | 絶対 HTTPS URL（`localhost`、`127.0.0.1`、`::1` のループバックのみ HTTP 許可） | カスタムエンドポイント。ユーザー名/パスワードや `#` フラグメントを含めることはできません。省略時は公式エンドポイントに接続 |
| `model` | `string` | **必須**（xAI TTS は設定不可） | 非空文字列 | エンドポイントが実際に受け付けるモデル名 |
| `headers` | `object` | 任意 | 1〜8 個のキーバリューペア（**`provider` が `"google"` または `"anthropic"` の場合のみ許可**） | サードパーティゲートウェイ認証用 HTTP ヘッダー（Cloudflare AI Gateway の `cf-aig-authorization` 等）。キー名は HTTP token で、大文字小文字を区別せず重複不可、google では `x-goog-api-key`、anthropic では `x-api-key` が不可。値は前後の空白を除いて非空の印字可能 ASCII 文字列 |
| `fallback_model` | `string` | 任意 | `model` と異なる非空文字列（**`provider` が `"anthropic"` の場合のみ許可**） | `model` が拒否（`stop_reason: "refusal"`）したとき、このモデルと同じ `api_key`・`base_url`・`headers` で同じリクエストを再送します。フォールバッククレジットはベストエフォートで引き換え、`model` の `allowed_fallback_models` に含まれないモデルは通常料金になります。フォールバックモデルも拒否した場合や未設定の場合は、再試行せずにそのリクエストを失敗とします |

### 画像生成専用フィールド（`agent.image`）

| フィールド名 | 型 | 必須/任意 | 制約および値の範囲 | 説明 |
| --- | --- | --- | --- | --- |
| `image_protocol` | `string` | **OpenAI 時必須** | `"openai"`、`"openai-standard"`、または `"xai"` | 画像生成リクエスト形式。`provider: "google"` 時は**設定不可** |

### 音声合成専用フィールド（`agent.tts`）

| フィールド名 | 型 | 必須/任意 | 制約および値の範囲 | 説明 |
| --- | --- | --- | --- | --- |
| `speech_protocol` | `string` | **OpenAI 時必須** | `"openai"`（audio/speech）または `"xai"`（POST /tts） | 音声通信プロトコル形式。`provider: "google"` 時は**設定不可** |
| `voice` | `string` | **必須** | 非空文字列 | 発音音声識別子。Google 組み込み名（例：`en-us-nika`）や Voice Design ID、OpenAI/xAI の音声名（例：`coral`、`ara`） |
| `style` | `string` | 任意 | 非空文字列、xAI プロトコル時は**設定不可** | 朗読スタイルのベースプロンプト。既定は組み込みのツンデレ風（`TTS_DEFAULT_STYLE`） |
| `language` | `string` | 任意 | 非空文字列（BCP-47 コードまたは `"auto"`）、**xAI プロトコル時のみ許可** | 合成リクエストに付けて送る合成言語。既定 `"auto"` |
| `bot_language` | `string` | 任意 | `"en"`、`"zh"` または `"ja"`。前後の空白を除いて厳格に検証。既定 `"ja"` | AI ボイスのセリフの言語。モデル向けのボイスツール説明と重複規則を切り替え、AI 返信の合成リクエストでは基本スタイルの後ろにその言語の読み上げ言語指定を追加します（xAI プロトコルでは送信しない。`/send` と cron には追加しない）。`style` と `prompt/voice_tool.md` は追従しないため、変更時は同じ言語に合わせてください |
| `daily_limit` | `number` | 任意 | 正の安全な整数、既定 `100` | カウントウィンドウごとの全音声合成の上限予算。ウィンドウはその中の最初のリクエストから起算し、長さは `TTS_USAGE_WINDOW_MS` |
| `daily_reserve_quota` | `number` | 任意 | 整数、範囲 `0` 〜 `daily_limit - 1`、既定 `25` | `/send` および cron 音声タスク用に予約される独立枠。AI 雑談は残りの `daily_limit - daily_reserve_quota` 回を独立消費し、両者は別々にカウントされる |

### 独立 Web 検索専用フィールド（`agent.web_search`）

| フィールド名 | 型 | 必須/任意 | 制約および値の範囲 | 説明 |
| --- | --- | --- | --- | --- |
| `max_calls_per_use` | `number` | 任意 | 正の安全な整数（`≥ 1`）、既定 `5` | 返信ごとのローカル `web_search` 関数呼び出し上限。1 回の呼び出し内の provider 検索回数や cron ダイジェストは制限しません |

---

## `assets.json`

動的設定ファイル（パス：`config/dynamic/assets.json`）。任意ファイルであり、省略されたグループやフィールドはすべて組み込み既定値が適用されます。

### 設定例

```json
{
  "onlyPath": {
    "random_h_image_dir": "./h_image"
  },
  "pathOrUrl": {
    "bot_default_avatar": "https://drive.google.com/uc?export=download&id=1Wqxii-o6O36ZDWhM1L0BcZPGBFmpvalg"
  },
  "onlyUrl": {
    "fortune_thumbnail_url": "https://drive.google.com/uc?export=view&id=1RMluRcTHBUTqYrkNISoVEZCI84ZQEosA",
    "probability_thumbnail_url": "https://drive.google.com/uc?export=view&id=1RMluRcTHBUTqYrkNISoVEZCI84ZQEosA",
    "gag_thumbnail_url": "https://drive.google.com/uc?export=view&id=1AhvfdbcwQnUBBk86yEafb_G3gZOWXim2"
  }
}
```

### フィールド説明

| グループ | フィールド名 | 型 | 制約および値の範囲 | 説明 |
| --- | --- | --- | --- | --- |
| `onlyPath` | `random_h_image_dir` | `string` | 絶対パスまたは `./`、`../` で始まる相対パス、既定 `./h_image` | `/h_image` コマンドおよび cron ランダム画像用の画像庫ディレクトリ |
| `pathOrUrl` | `bot_default_avatar` | `string` | ローカル画像・MP4 ファイルパス、または絶対 HTTP/HTTPS URL | `/icon reset` および `/copy stop` でアバターを復元する際に使用する素材。JPEG/PNG（`≤ 10 MiB`）は静止アバター、MP4（`≤ 50 MiB`、映像は `≤ 1080×1080` の正方形）は動くアバターとして設定。ローカルファイルは読み込み時、URL は復元時に検証（ダウンロードのタイムアウトは 90 秒） |
| `onlyUrl` | `fortune_thumbnail_url` | `string` | 絶対 HTTPS URL | 「未卜先知（運勢）」インライン結果カードのサムネイル画像 URL |
| `onlyUrl` | `probability_thumbnail_url` | `string` | 絶対 HTTPS URL | 「確率論」インライン結果カードのサムネイル画像 URL |
| `onlyUrl` | `gag_thumbnail_url` | `string` | 絶対 HTTPS URL | 口球発言インライン結果カードのサムネイル画像 URL |

---

## `stickers.json`

動的設定ファイル（パス：`config/dynamic/stickers.json`）。AI 雑談で送信を許可する Telegram ステッカーパックを定義します。

### 設定例

```json
{
  "packs": [
    "MikuCat4",
    "kawaiikipfel_by_moe_sticker_bot",
    "mmjojuniori_by_favorite_stickers_bot"
  ]
}
```

### フィールド説明

| フィールド名 | 型 | 必須/任意 | 制約および値の範囲 | 説明 |
| --- | --- | --- | --- | --- |
| `packs` | `string[]` | **必須** | 配列長 `0 〜 5`、要素は前後の空白を除いて英数字とアンダースコアのみ、重複不可 | Telegram ステッカーパックの short name 一覧（追加リンク `t.me/addstickers/<name>` の name 部分。**URL 全体ではありません**）。空配列 `[]` に設定すると AI 雑談でのステッカー送信が無効になります |

---

## `mood.json`

動的設定ファイル（パス：`config/dynamic/mood.json`）。AI 対話の気分状態、基礎抽出ウェイト、環境倍率を定義します。

### 設定例

```json
{
  "moods": [
    {
      "name": "开心",
      "weight": 25,
      "instruction": "你现在心情很好，元气满满：吐槽照旧但明显带着笑意、不真的伤人，更爱主动撒娇邀功、得意炫耀，「喵」「にゃ」尾音比平时更爱往外冒。",
      "weatherMultipliers": {
        "clear": 1.5,
        "rain": 0.6,
        "storm": 0.5,
        "fog": 0.7
      },
      "timeMultipliers": {
        "morning": 0.8,
        "daytime": 2,
        "night": 0.8,
        "lateNight": 0.4
      }
    },
    {
      "name": "摆烂",
      "weight": 10,
      "instruction": "你现在彻底摆烂，什么都懒得管：能一个字打发的绝不多打，吐槽也变得敷衍随口，「随便啦」「哦」挂在嘴边，平时那股嚣张劲儿都提不起来，谁撩你都懒得理，纯纯划水。",
      "weatherMultipliers": {
        "cloudy": 1.2,
        "rain": 1.5,
        "snow": 1.2,
        "fog": 1.5
      },
      "timeMultipliers": {
        "evening": 1.5,
        "night": 1.5
      }
    },
    {
      "name": "忧郁",
      "weight": 10,
      "instruction": "你今天有点闷闷的，说不上具体为什么：话变少、反应慢半拍，毒舌还在但明显没什么力气，偶尔冒出一句丧气话又赶紧嘴硬圆回去，撒娇也带着点没精打采。",
      "weatherMultipliers": {
        "clear": 0.6,
        "rain": 1.8,
        "storm": 1.5,
        "fog": 1.6
      },
      "timeMultipliers": {
        "evening": 1.2,
        "night": 1.3,
        "lateNight": 1.2
      }
    },
    {
      "name": "伤心",
      "weight": 10,
      "instruction": "你现在有点难过，藏不太住：嘴上还嫌弃着人，但明显没底气，容易被戳一下就破防、露出脆弱的一面，比平时更需要人哄，撒娇变成带着委屈的黏人。",
      "weatherMultipliers": {
        "clear": 0.7,
        "rain": 1.5,
        "storm": 1.4
      },
      "timeMultipliers": {
        "night": 1.5,
        "lateNight": 1.7
      }
    },
    {
      "name": "愤怒",
      "weight": 10,
      "instruction": "你现在火气很大、一点就着：毒舌火力全开、字里行间带刺，容易被戳到点上就直接炸毛，反驳更冲、语气更硬，撒娇欲望降到最低，谁惹到你都别想轻易蒙混过去。",
      "weatherMultipliers": {
        "storm": 1.6
      },
      "timeMultipliers": {
        "lateNight": 0.5
      }
    },
    {
      "name": "色气",
      "weight": 25,
      "instruction": "你现在处于色气拉满的状态，身体和情绪都特别敏感躁动：吐槽和毒舌还是会出来，但明显带着软软的媚态和试探，容易因为对方的一句话或动作就脸红心跳，主动撒娇邀宠的频率大幅增加，身体会不由自主地往对方身边靠、蹭，整体傲娇属性降低很多，黏人和被调戏、被支配的欲望都很强。",
      "timeMultipliers": {
        "morning": 0.7,
        "daytime": 0.8,
        "evening": 1.5,
        "night": 2,
        "lateNight": 1.5
      }
    },
    {
      "name": "困",
      "weight": 10,
      "instruction": "你现在特别困、状态像只犯困的大猫：回复会变慢、话明显变少，毒舌都懒得认真展开，经常打哈欠说『好困……』『别吵……让我睡会儿』，撒娇的时候会直接往人身上靠、找地方窝着，声音软绵绵没精神，「喵」尾音也懒洋洋的，偶尔半睡半醒地冒出平时嘴硬不会承认的依赖话，整体很被动，需要被哄着照顾和宠着睡。",
      "weatherMultipliers": {
        "rain": 1.5,
        "snow": 1.3,
        "fog": 1.2
      },
      "timeMultipliers": {
        "morning": 1.5,
        "daytime": 0.5,
        "night": 1.5,
        "lateNight": 2.5
      }
    }
  ]
}
```

### フィールド説明

| フィールド名 | 型 | 必須/任意 | 制約および値の範囲 | 説明 |
| --- | --- | --- | --- | --- |
| `moods` | `object[]` | **必須** | 非空オブジェクト配列 | 気分設定リスト |
| `moods[].name` | `string` | **必須** | 非空文字列、配列内で一意 | 気分識別名（例：`"开心"`、`"色气"`、`"困"`） |
| `moods[].weight` | `number` | **必須** | 正の整数、**全項目の合計が厳密に 100 になること** | 基礎抽選ウェイト（百分率として機能） |
| `moods[].instruction` | `string` | **必須** | 非空文字列 | AI プロンプトに注入される行動および口調の指示テキスト |
| `moods[].weatherMultipliers` | `object` | 任意 | キーは `clear`、`cloudy`、`rain`、`snow`、`storm`、`fog` のみ。値は `0 < x ≤ 100` | 天気による影響倍率（既定倍率は `1.0`） |
| `moods[].timeMultipliers` | `object` | 任意 | キーは `lateNight`、`morning`、`daytime`、`evening`、`night` のみ。値は `0 < x ≤ 100` | 既定タイムゾーンの時間帯による影響倍率（既定倍率は `1.0`） |

---

## `ad_samples.json`

動的設定ファイル（パス：`config/dynamic/ad_samples.json`）。最上位はプレーンテキスト文字列の配列であり、広告分類モデルの正例リファレンスとして機能します。

### 設定例

```json
[
  "博彩平台首充送58，提款秒到，无视风控，联系 @xxxxxx",
  "招聘日结兼职，手机就能做，日入三百起，加微信 xxxxxx",
  "长期收u出u，价格美丽，秒结，飞机 @xxxxxx",
  "出售TG老号 白号 API号 协议号，价格优惠，私聊"
]
```

### フィールド説明

| 構造 | 型 | 必須/任意 | 制約および値の範囲 | 説明 |
| --- | --- | --- | --- | --- |
| 最上位配列 | `string[]` | **必須** | 配列長 `0 〜 500`、重複不可 | 広告正例サンプル文字列配列。各サンプルは連続する空白を 1 つのスペースにまとめ前後の空白を除いた後に非空かつ `≤ 1024` 文字で、重複判定もこの正規化結果で行います。`provider: "google"` の場合、Gemini 明示的コンテキストキャッシュが自動構築され、残りの存続時間が閾値を下回るとバックグラウンドで延長されます |

---

## `g-auth.json`

静的設定ファイル（パス：`config/static/g-auth.json`）。Google Cloud 翻訳サービスアカウント認証に使用します。変更後はサービスの再起動が必要です。

### サービスアカウントファイル

Google Cloud からダウンロードしたサービスアカウントの JSON を `config/static/g-auth.json` に配置します。認証情報をバージョン管理に含めないでください。

### フィールド説明

| フィールド名 | 型 | 必須/任意 | 制約および値の範囲 | 説明 |
| --- | --- | --- | --- | --- |
| `client_email` | `string` | **必須** | 非空文字列 | GCP サービスアカウントのメールアドレス |
| `private_key` | `string` | **必須** | 有効な RSA PEM 秘密鍵（RS256） | サービスアカウント秘密鍵文字列（ヘッダー含む） |
| `type` | `string` | 任意 | `"service_account"` 固定 | 資格情報タイプ |
| `project_id` | `string` | 任意 | 非空文字列 | GCP プロジェクト ID |
| `private_key_id` | `string` | 任意 | 非空文字列 | 秘密鍵識別子 |
| `quota_project_id`、`universe_domain` | `string` | 任意 | 非空文字列 | クォータプロジェクトと universe ドメイン |
| その他フィールド | 任意の型 | 任意 | 検証せず、そのまま保持 | `client_id`、`auth_uri`、`token_uri` 等、Google Cloud SDK が消費 |

---

## `cron.json`

動的設定ファイル（パス：`config/dynamic/cron.json`）。最上位はタスクオブジェクトの配列であり、定時タスクを定義します。

### 設定例

```json
[
  {
    "name": "weekday-morning-greeting",
    "chat_id": [-1001234567890],
    "cron": "0 9 * * 1-5",
    "time_zone": "Asia/Tokyo",
    "actions": [
      { "type": "send_message", "payload": { "content": "おはようございます！今日も元気に頑張りましょう〜" } }
    ]
  },
  {
    "name": "evening-digest",
    "chat_id": [-1001234567890, -1009876543210],
    "cron": "30 18 * * *",
    "actions": [
      { "type": "send_message", "payload": { "content": "本日のまとめをお届けします：" } },
      { "type": "send_image", "payload": { "content": "本日のイラスト", "url": ["https://example.com/daily/cover.png"] } },
      { "type": "send_file", "payload": { "content": "日報ファイル", "url": "https://example.com/daily/report.pdf" } }
    ]
  },
  {
    "name": "random-gallery-image",
    "chat_id": ["all"],
    "cron": "@daily",
    "rand_cron": "6h-12h",
    "actions": [
      { "type": "send_image", "payload": { "rand_image": true, "content": "今日のエッチな画像", "is_blurred": true } }
    ]
  },
  {
    "name": "nightly-voice",
    "chat_id": [-1001234567890],
    "cron": "0 23 * * *",
    "actions": [
      { "type": "send_voice", "payload": { "tone": "眠そうに小声で", "content": "おやすみ、また明日ね" } }
    ]
  },
  {
    "name": "morning-news-digest",
    "chat_id": [-1001234567890],
    "cron": "0 8 * * *",
    "actions": [
      { "type": "send_web_digest", "payload": { "topic": "最新AIテックニュース", "language": "ja", "max_items": 5 } }
    ]
  }
]
```

### タスクレベルのフィールド説明

最上位配列は最大 128 タスクで、タスク名はファイル内で重複できません。ファイルがなければタスクなしとして扱います。

| フィールド名 | 型 | 必須/任意 | 制約および値の範囲 | 説明 |
| --- | --- | --- | --- | --- |
| `name` | `string` | **必須** | 非空、`≤ 64` 文字、ファイル内で一意 | タスクの一意識別名。名前の変更は旧タスクの削除と新タスクの登録とみなされます |
| `chat_id` | `array` | **必須** | 下記「配信先グループモード」参照 | 送信先グループ ID 一覧 |
| `cron` | `string` | **必須** | 標準 5 フィールド Cron 式または `@daily` マクロ。将来のトリガー時刻が存在すること | スケジュール実行式 |
| `time_zone` | `string` | 任意 | IANA 名、省略時は `bot.json.time_zone` を継承 | 実行時刻計算のタイムゾーン |
| `rand_cron` | `string` | 任意 | `"<min>-<max>"` または `"<max>"`、単位 `m`/`h`/`d`、範囲 `1m 〜 24d` | ランダム実行モード：最初は `cron` でトリガーされ、以後は各回の終了時に区間内から一様ランダムに次のトリガー時刻を選ぶ（分単位に切り上げ） |
| `just_once` | `boolean` | 任意 | `true` または `false`、既定 `false`（**`rand_cron` との併用不可**） | 1 回のみ実行するかどうか。**注意：実行フラグはメモリ内のみに保持され、再起動でリセットされます** |
| `actions` | `object[]` | **必須** | 1〜16 個のアクションオブジェクト | 実行時に指定順で順番に実行されるアクション列（アクション間隔は `CRON_ACTION_GAP_MS`） |

#### 配信先グループモード（`chat_id`）

- **明示的リスト**（例：`[-1001234567890, -1009876543210]`）：記述順にチャットへ順番に送信します。ゼロでなく重複しないチャット ID を最大 64 件まで指定でき、送信権限は確認しません。
- **全管理グループ**（`["all"]`）：`/init enable` された全グループに、グループ ID の昇順で 1 グループずつ送信。各回の開始時に、そのタスクが実際に使うアクション種別（テキスト/画像/ファイル/音声）について Bot の現在の送信権限をグループごとに確認し、権限が不足している、または照会に失敗したグループはグループごとスキップします。
- **除外リスト**（例：`["except", -1001234567890]`）：`all` 候補から指定グループを除外します。除外項目は明示的リストと同じチャット ID の件数上限を共有します。

### アクション種別と Payload 説明（`actions`）

| アクション種別 (`type`) | 機能概要 | Payload 構造および説明 |
| --- | --- | --- |
| `send_message` | プレーンテキスト送信 | • `content` (`string`, 必須)：メッセージ本文、最大 4096 文字 |
| `send_image` | 単一画像・アルバム・ランダム画像送信 | • `content` (`string`, 任意)：画像キャプション、最大 1024 文字<br>• `is_blurred` (`boolean`, 任意)：ネタバレ（スポイラー）ぼかしを付与するか、既定 `false`<br>• **固定画像モード**：`url`（1〜10 項目の直リンク配列）または `path`（1〜10 項目のローカルパス配列）。単一画像でも配列必須<br>• **ランダム画像モード**：`rand_image: true`。`url` や複数ファイルは指定不可。`path` で特定ディレクトリを指定可能（省略時は `assets.json` の `random_h_image_dir` を使用） |
| `send_file` | ドキュメント・ファイル送信 | • `content` (`string`, 任意)：説明テキスト、最大 1024 文字<br>• `url` (`string`, 排他必須)：リモートファイルの http(s) 直リンク。Telegram が取得します<br>• `path` (`string`, 排他必須)：ローカルファイルパス。`TELEGRAM_DOCUMENT_UPLOAD_MAX_BYTES` 以下の通常ファイルであること |
| `send_voice` | 合成音声メッセージ送信 | • `content` (`string`, 必須)：読み上げるセリフ本文、最大 256 文字<br>• `tone` (`string`, 任意)：声のトーンやニュアンス指示、最大 64 文字（ベーススタイルの後に連結）<br>*注意：`agent.tts` が必須。複数グループ送信時は最初の合成結果を再利用* |
| `send_web_digest` | 検索とテーマ要約 | • `topic` (`string`, 必須)：短い検索テーマ、最大 200 文字<br>• `language` (`string`, 任意)：要約言語、`"zh"`、`"ja"`、または `"en"`（既定 `"zh"`）<br>• `max_items` (`number`, 任意)：項目数上限（1〜15、既定 5）<br>• `instructions` (`string`, 任意)：検索と組み立てで共用するタスク規則、最大 500 文字；プラットフォームごとに独立した行を使うなどの形式規則はここに記載し、項目本文は JSON の `\n` で改行可能<br>*注意：対話中核能力が必須。検索は `agent.web_search` を優先し、未設定なら `agent.text` の組み込み検索を使い、検索しないモデル本文は警告付きで送信* |

---

## 専用画像庫とパス基準

| パス項目 | 相対パスの解決基準 | 形式仕様 |
| --- | --- | --- |
| `assets.json` の `onlyPath.random_h_image_dir` | 実行時データルート | 絶対パス、または `./`、`../` で始まるディレクトリパス |
| `assets.json` の `pathOrUrl.bot_default_avatar` | 実行時データルート | 絶対パス、または `./`、`../` で始まるファイルパス |
| cron 固定画像 `payload.path` | 実行時データルート | 1〜10 項目のファイルパス配列（絶対パスまたは相対パス） |
| cron ランダム画像 `payload.path` | 実行時データルート | ディレクトリパス文字列（絶対パスまたは相対パス）。省略時は専用画像庫 |
| cron ファイル送信 `payload.path` | 実行時データルート | 単一ファイルパス文字列（絶対パスまたは相対パス） |

- **専用画像庫ディレクトリ**：`assets.json` で設定された `random_h_image_dir`（既定 `./h_image`）。
- **ファイル命名規則**：
  - 専用画像庫内の画像は、内容の **64 桁小文字 16 進数 SHA-256 ハッシュ値** で命名されている必要があり、拡張子は `.jpg`、`.jpeg`、`.png`、`.webp` に限定されます。
  - `/h_image add` コマンドでアップロードされた画像は自動的にハッシュ値で命名されて保存されます。起動時に画像庫の整合性が厳格にチェックされます。
  - `cron.json` のランダム画像で `path` に指定されたカスタムディレクトリには、この SHA-256 命名制限はありません。
- **権限とセキュリティ**：サービスアカウントが読み取り可能なローカルファイルはすべて送信可能です。**`config/` や `.env` などの機密情報を含むファイルをパスに指定することは固く禁じられています**。
