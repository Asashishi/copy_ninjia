# 11 よくある質問

<p align="center">
  <a href="../cn/11-faq.md">简体中文</a> · <a href="../en/11-faq.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 ドキュメントホーム</a> · <a href="10-performance.md">← 前のページ：10 パフォーマンスベンチマーク</a> · <b>次のページ：なし →</b>
</p>

---

Bot プロセスは稼働しているのにグループで応答がないときは、以下のチェックリストを順に確認してください。BotFather の設定および各機能に必要なグループ管理者権限については [README](README.md#botfather-setup) を参照してください。

## Bot は動いているのに、なぜ返答がないのか？

<table width="100%">
<thead>
  <tr>
    <th width="28%" align="left">事象の分類</th>
    <th width="72%" align="left">切り分け方向と確認ステップ</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr>❌ <b>グループで一切反応がない</b></nobr></td>
    <td>
      • <b>未初期化</b>：スーパー管理者による <code>/init enable</code> がまだ実行されていません。<br>
      • <b>プライバシーモードによる遮断</b>：Bot がグループ管理者権限を持たず、かつ BotFather で Group Privacy が無効化されていません（<code>/setprivacy → Disable</code>）。<i>注：設定変更後は Bot を一度グループから退出させて再参加させてください。</i>
    </td>
  </tr>
  <tr>
    <td><nobr>🤖 <b>AI 雑談が応答しない</b></nobr></td>
    <td>
      • <b>未有効化</b>：グループ内で <code>/ai_chat enable</code> を実行する必要があります（デフォルト無効）。<br>
      • <b>設定の不備</b>：<code>agent.json</code> 内の <code>text</code>、<code>summary</code>、<code>media</code> の 3 項目と、<code>stickers.json</code>、<code>mood.json</code> が必要です。いずれかが欠けると AI 雑談は動作しません。<br>
      • <b>トリガー条件</b>：Bot への返信または <code>@Bot</code> メンションでのみ確実にトリガーされます。その他の通常発言はランダムな確率で割り込みます（<code>/quiet</code> による静寂中は割り込みません）。<br>
      • <b>モードの排他</b>：<code>/copy</code> 復唱中は AI 雑談および自発的な割り込み動作が一時停止します。<br>
      • <b>レート制限</b>：発言頻度が高い場合、スライディングウィンドウ制限が適用されます（ウィンドウと上限値は <code>RATE_LIMIT_LONG_WINDOW_MS</code>、<code>RATE_LIMIT_LONG_MAX_TRIGGERS</code> を参照）。
    </td>
  </tr>
  <tr>
    <td><nobr>📨 <b>個別チャットで反応がない</b></nobr></td>
    <td>
      • 個別チャットはスーパー管理者の <code>/send</code> 中継コマンドにのみ応答します。通常コマンドや雑談には応答しません。
    </td>
  </tr>
  <tr>
    <td><nobr>⏱️ <b>通知が表示後すぐに消える</b></nobr></td>
    <td>
      • <b>正常な仕様</b>：コマンドの検証失敗、権限拒否、使い方案内、操作結果の通知は、送信成功から <code>COMMAND_MESSAGE_AUTO_DELETE_MS</code>（30 秒）経過後に自動削除されます（長期保持される例外は <a href="09-commands.md#パラメータと対象のマッチング規約">09 コマンド</a> を参照）。
    </td>
  </tr>
  <tr>
    <td><nobr>🎲 <b><code>@Bot</code> で運勢が出ない</b></nobr></td>
    <td>
      • @BotFather で Inline Mode が有効化されていません（<code>/setinline</code>）。
    </td>
  </tr>
  <tr>
    <td><nobr>🫧 <b>アクションコマンドが動かない</b></nobr></td>
    <td>
      • 1〜2 文字の漢字によるアクションワードのみを認識します。グローバルなスライディングウィンドウ制限（<code>CJK_ACTION_RATE_LIMIT_WINDOW_MS</code> のウィンドウごとに最大 <code>CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW</code> 回）があり、上限超過分は静かに破棄されます。
    </td>
  </tr>
  <tr>
    <td><nobr>🌐 <b>他の Bot が翻訳・復唱されない</b></nobr></td>
    <td>
      • @BotFather で <b>Bot-to-Bot Communication Mode</b> を有効化する必要があります。<br>
      • 他の Bot から届くメッセージにはグローバルな入口制限があります。継続して発言する同一 Bot のメッセージは <code>BOT_MESSAGE_ACTIVITY_LIMIT</code> 件を超えると無視され、<code>BOT_MESSAGE_ACTIVITY_TTL_MS</code> 発言がなければカウントがリセットされます。記録数が <code>BOT_MESSAGE_ACTIVITY_MAX_ENTRIES</code> に達している間は新規 Bot のメッセージを受け付けません（詳細は <a href="04-invariants.md">dispatch の不変条件</a> を参照）。<br>
      • 翻訳はテキストとキャプションのみを扱い、純粋なメディアや数字・記号のみのメッセージは送信しません。
    </td>
  </tr>
  <tr>
    <td><nobr>🛡️ <b>認証 / 広告 / 連投が無反応</b></nobr></td>
    <td>
      • <b>デフォルト無効</b>：<code>/antiraid enable</code>、<code>/ad_detect enable</code>、<code>/flood_control enable</code> で個別に有効化してください。<br>
      • <b>管理者権限不足</b>：Bot にメッセージ削除やメンバー制限の管理者権限が付与されている必要があります。<br>
      • <b>設定の不備</b>：広告検出には <code>config/dynamic/agent.json</code> の <code>agent.ad_detect</code> と <code>config/dynamic/ad_samples.json</code> が必要です。
    </td>
  </tr>
  <tr>
    <td><nobr>💀 <b>プロセス停止、メニューも出ない</b></nobr></td>
    <td>
      • <b>サービス稼働確認</b>：<code>systemctl status &lt;サービス名&gt;</code> でプロセス状態を確認してください。<br>
      • <b>設定エラーによる終了</b>：データルートの <code>logs/&lt;日付&gt;.json</code> を確認してください。不正な設定が存在すると起動時に安全のため停止し、エラー箇所を出力します。<br>
      • <b>トークン競合（409 エラー）</b>：ログに 409 Conflict が記録されている場合、同一トークンで他インスタンスが稼働中であるか、Webhook が解除されていません（詳細は <a href="07-operations.md#起動失敗の調査">07 運用</a> を参照）。
    </td>
  </tr>
</tbody>
</table>

---

## 通知の口調を切り替えるには？

- `config/static/bot.json` 内で `atmosphere` を `mesugaki`（メスガキ版）または `normal`（通常版）に明示指定すると、ペルソナに基づくデフォルト値より優先され、再起動後に反映されます。
- `atmosphere` を省略した場合、プロジェクトルートに `prompt/persona.md` が存在すれば全グループの通知とメニューは通常版となり、存在しなければメスガキ版となります。
- 通知の口調はシステム通知やボタン文言のスタイルのみを変更し、AI 雑談の System Prompt ペルソナは変更しません。

---

## 画像ライブラリが起動拒否される、または画像収集で重複排除されない原因は？

- **ファイル規約**：専用画像ライブラリディレクトリ（`assets.json` の `random_h_image_dir`）には、**バイナリコンテンツの SHA-256**（64 文字の小文字 16 進数）で命名された正規の画像ファイルのみを配置できます。
- **起動時インターセプト**：ディレクトリ内にサブディレクトリ、シンボリックリンク、隠しファイル、または残存した一時ファイルが存在する場合、起動前チェックにより起動が拒否されます。サービスを停止してバックアップを取得した上で、[07 運用とトラブルシューティング](07-operations.md) に従って不要なファイルをクリーンアップしてください。
- **重複排除ロジック**：画像収集時の重複排除はダウンロード後のハッシュ計算段階で行われます。ライブラリ内に同一ハッシュのファイルが既に存在する場合は直接スキップされ、収録済みである旨が案内されます。手動で配置された画像は、同一のダイジェスト名と拡張子を保持している場合のみ重複排除にヒットします。

---

## 定時タスクが再起動後に再送信されるのはなぜか？

- `just_once` の実行記録はメモリ内にのみ保持されるため、プロセス再起動時に再登録されます。実行が完了した単発タスクは `config/dynamic/cron.json` から削除してください。
- `rand_cron` のランダム実行時刻も再起動後に指定範囲内で再抽選されます。サービス停止期間中にスキップされたタスクは補填送信されません。
- 固定画像の `url` または `path` は配列でなければなりません（要素数の上限は [デプロイ設定説明](../../config_example/README/ja.md#cronjson) を参照）。`cron.json` 内の相対パスは一律で実行時データルートからの相対パスとして解決されます（`./` 接頭辞は不要です）。

---

## 定時音声や `/send` の音声が送信されない原因は？

定時タスクの `send_voice` およびスーパー管理者の個人チャット `/send` による音声代行はいずれも `config/dynamic/agent.json` の `agent.tts` 設定に依存し、AI Worker 上で非同期合成されます：

### ログ特徴による原因切り分け

<table width="100%">
<thead>
  <tr>
    <th width="35%" align="left">ログの特徴</th>
    <th width="65%" align="left">根本原因と対処ガイド</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><code>speech synthesis failed: worker unavailable</code></td>
    <td>AI Worker が準備完了していません（<code>stickers.json</code>、<code>mood.json</code>、<code>agent.json</code> を確認）。</td>
  </tr>
  <tr>
    <td><code>tts unsupported</code></td>
    <td>指定されたプロバイダが音声合成に未対応です（現在は <code>google</code> と <code>openai</code> のみ対応）。</td>
  </tr>
  <tr>
    <td><code>synthesis failed</code> / <code>timed out</code></td>
    <td>モデル呼び出しの失敗またはタイムアウト。OpenAI 互換プロバイダでは <code>audio/speech</code> と <code>opus</code> が必須です。</td>
  </tr>
  <tr>
    <td><code>not an Ogg Opus stream</code> / <code>not an MP3 stream</code></td>
    <td>返却された音声ストリーム形式が要求プロトコルと一致していません。</td>
  </tr>
  <tr>
    <td><code>daily limit reached</code></td>
    <td>音声クォータを使い切りました。現在のカウントウィンドウ（<code>TTS_USAGE_WINDOW_MS</code>）が終了するまで待機する必要があります。</td>
  </tr>
</tbody>
</table>

### クォータと割り当ての仕組み

- `/send` と `cron.json` は独立した **`daily_reserve_quota`** を共有し、`reserveCount` に記録されます。
- AI 雑談は残りの **`daily_limit - daily_reserve_quota`** を独立して使用し、`agentCount` に記録されます。
- 両者のクォータは相互に完全隔離されており、互いの枠を圧迫しません。カウントウィンドウはその中の最初のリクエストから起算され、ウィンドウ（`TTS_USAGE_WINDOW_MS`）終了後の次のリクエストで新しいウィンドウが開始され、カウントはゼロにリセットされます。

### 個人チャット `/send` のフォーマット要件

個人チャットでの音声リクエストは、**メッセージ全体がコードブロック**であり、かつ `type` が `tts` と指定されている必要があります：
```json
{ "type": "tts", "tone": "ツンデレ", "text": "合成するセリフ" }
```
コードブロックの内容は JSONC として解析され、コメントと末尾のカンマを使用できます。解析に失敗するか `type` が `"tts"` でない場合は、元のメッセージがそのまま対象グループへ転送されます。`type` が `"tts"` でもフィールドが不正な場合は、スーパー管理者の個人チャットに形式の案内を返し、対象グループには転送しません。

---

## 音声の長さ・温度・記憶はどう設定するか？

| エントリ | セリフ上限 (UTF-16) | 送信成功後の AI 記憶 |
| :--- | :---: | :--- |
| **AI `send_voice`** | `VOICE_TEXT_MAX_CHARS` | セリフを記録 |
| **個人チャット `/send` TTS** | `VOICE_OPERATOR_TEXT_MAX_CHARS` | 自動記録なし |
| **cron `send_voice`** | `VOICE_OPERATOR_TEXT_MAX_CHARS` | 自動記録なし |

- **口調と長さ**：`tone`（口調）の上限は一律で `VOICE_TONE_MAX_CHARS`（UTF-16 コード単位）です。空白はトリム正規化後に検証されます。音声レスポンスのバイナリサイズ上限は `VOICE_SPEECH_MAX_BYTES` です。
- **声色とスタイル**：
  - 声色は `agent.tts.voice` で設定します。
  - 基本スタイルは任意の `agent.tts.style` で設定し（ホットリロード対応）、省略時は内蔵の `TTS_DEFAULT_STYLE` を使用します。
  - 送信時に `<基本スタイル>; 细节: <口調>` として自動結合されます。AI 返信の合成では両者の間に読み上げ言語指定が挿入されます（下記のセリフの言語を参照）。
  - `speech_protocol: "xai"` プロトコルは `style` フィールドをサポートしておらず、口調も送信されません。
- **セリフの言語**：AI `send_voice` のセリフの言語は任意の `agent.tts.bot_language` で設定します（`en` / `zh` / `ja`、省略時 `ja`。ホットリロード対応で、次の返信から反映）。`send_voice`・`send_message` のツール説明と system prompt 内のボイス重複規則を切り替え、AI 返信の合成リクエストでは基本スタイルの後ろにその言語の読み上げ言語指定を追加します（`<基本スタイル>; <読み上げ言語>; 细节: <口調>`。文言は `VOICE_LANGUAGE_PROMPTS` の `speechLanguageStyle` に登録）。`style` は変えず、`/send` と cron のセリフおよび合成リクエストにも影響しません。xai プロトコルで API に送信される合成言語は引き続き `language` で決定されます。
- **セリフ言語変更時の推奨設定**：AI 返信の読み上げ言語指定は `bot_language` に従って自動追加されますが、`voice`・`style`・`prompt/voice_tool.md` は連動しません。`bot_language` を切り替える場合は以下を推奨します：
  - `style` をその言語で書かれた声質説明に書き換えます（省略時の `TTS_DEFAULT_STYLE` は日本語の説明です）。`style` は `/send` や cron でも共通利用されるため、声質のみを記述し、特定の言語指定は含めないでください。`/send` や cron で言語を指定したい場合は、各リクエストの `tone` に記述します。`style` を調整しても不自然さが残る場合は、該当言語向けに設計された音色（`voice`）に変更してください。
  - `prompt/voice_tool.md` を配置している場合は、セリフの言語・セリフ例・口調例を同一言語に揃えてください。このファイルの変更を反映するにはプロセスの再起動が必要です。
  - xai プロトコルにはスタイル設定が存在しないため、読み上げ言語指定も口調も送信されません。該当する場合は `language` を変更してください。
- **ボイスツール説明のカスタマイズ**：プロジェクトルートに `prompt/voice_tool.md` を配置すると、再起動後に `bot_language` の値にかかわらず、そのファイル本文で `send_voice` のツール説明全体が置換されます。`text` / `tone` 引数の説明とボイス重複規則は引き続き `bot_language` に基づいて選択されます。空ファイルまたは不正な UTF-8 の場合は起動を拒否し、ホットリロードは行いません。
- **サンプリング温度**：Gemini 音声サンプリングの温度はコードベース定数 `GEMINI_SPEECH_TEMPERATURE` によって固定されています。

---

## サードパーティゲートウェイ（Cloudflare AI Gateway 等）経由で Google モデルを呼び出すには？

1. **エンドポイントの設定**：該当する能力の `base_url` をゲートウェイのアドレスに変更します。例：
   `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/google-ai-studio`
2. **認証ヘッダーの付加**：同一能力の下に `headers` を設定します。例：
   ```json
   "headers": {
     "cf-aig-authorization": "Bearer <token>"
   }
   ```
3. **API Key の保持**：`api_key` には引き続き必須の Google API キーを設定します。ゲートウェイ保管キー（BYOK / Unified Billing）を使う場合は代わりに Cloudflare トークンを設定し、`headers` は不要です。`headers` は `provider: "google"` と `provider: "anthropic"` の場合にのみ有効であり（openai は不可）、機密値はログ出力時に自動的にマスキングされます。
4. **ルーティングの網羅**：テキスト、画像認識、画像生成は generateContent ルーティングを通過し、音声合成は Interactions API を通過します。設定完了後、`/send` 経由で音声を 1 回送信してゲートウェイの疎通を確認できます。

---

## Cloudflare AI Gateway 経由で Anthropic モデルを呼び出すには？

`provider: "anthropic"` の能力（`text`、`summary`、`media`、`web_search`、`ad_detect`）は、`headers` を SDK の `defaultHeaders` としてすべてのリクエストに付加します。`base_url` は次のとおり設定します：
`https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`

1. **自前の Anthropic キーを使う場合**：`api_key` に Anthropic API キーを設定します（SDK が `x-api-key` として送信）。ゲートウェイ認証（Authenticated Gateway）が有効な場合は次を追加します：
   ```json
   "headers": {
     "cf-aig-authorization": "Bearer <CF_AIG_TOKEN>"
   }
   ```
   ゲートウェイ認証が無効な場合は `headers` は不要です。
2. **ゲートウェイ保管キー（BYOK / Unified Billing）**：`api_key` に Cloudflare トークン `<CF_AIG_TOKEN>` をそのまま設定します。`headers` は不要です。ゲートウェイは `x-api-key` 内の Cloudflare トークンを認識し、保管済みの Anthropic キーまたは Unified Billing に切り替えます。`api_key` にプレースホルダーを設定すると、そのまま Anthropic に転送されて認証エラーになります。
3. **フィールド制約**：`headers` に `x-api-key`（大文字小文字を区別しない）は含められず、Anthropic の資格情報は `api_key` のみで渡します。その他の制約は Google プロバイダと同一です。各ヘッダー値はログのマスキング対象に登録されます。

---

<div align="center">

[← 前のページ：10 パフォーマンスベンチマーク](10-performance.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#11-よくある質問)

</div>
