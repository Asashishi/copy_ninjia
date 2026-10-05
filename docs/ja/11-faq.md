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
      • <b>プライバシーモードによる遮断</b>：Bot がグループ管理者でなく、BotFather で Group Privacy が解除されていません（<code>/setprivacy → Disable</code>）。<i>注：変更後は Bot を一度退出させて再参加させてください。</i>
    </td>
  </tr>
  <tr>
    <td><nobr>🤖 <b>AI 雑談が応答しない</b></nobr></td>
    <td>
      • <b>未有効化</b>：グループで <code>/ai_chat enable</code> を実行する必要があります（既定で無効）。<br>
      • <b>トリガー条件</b>：Bot への返信または <code>@Bot</code> メンションのみ確実にトリガーします。その他の通常発言はランダム確率で割り込みます（<code>/quiet</code> 中は割り込みません）。<br>
      • <b>モード排他</b>：<code>/copy</code> 復唱中は AI 雑談が一時停止します。<br>
      • <b>レート制限</b>：発言頻度が高いと 5 分間のスライディングウィンドウ制限がかかります。
    </td>
  </tr>
  <tr>
    <td><nobr>📨 <b>個別チャットで反応がない</b></nobr></td>
    <td>
      • 個別チャットはスーパー管理者の <code>/send</code> 中継コマンドにのみ応答します。通常コマンドや雑談は無視されます。
    </td>
  </tr>
  <tr>
    <td><nobr>⏱️ <b>通知が表示後すぐに消える</b></nobr></td>
    <td>
      • <b>設計通りの動作</b>：検証失敗、権限拒否、使い方、操作結果の通知は送信成功から <b>30 秒後に自動削除</b>されます（例外は <a href="09-commands.md">09 コマンド</a> 参照）。
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
      • 1〜2 文字の漢字によるアクションワードのみを認識します。グローバル制限として 90 秒間に最大 450 回まで応答します。
    </td>
  </tr>
  <tr>
    <td><nobr>🌐 <b>他の Bot が翻訳・復唱されない</b></nobr></td>
    <td>
      • @BotFather で <b>Bot-to-Bot Communication Mode</b> を有効化する必要があります。<br>
      • 他の Bot から届くメッセージにはグローバルな入口制限があります。継続して発言する同一 Bot の 16 件目以降は無視し、90 分間発言がなければカウントをリセットします。512 Bot ID を記録している間は新しい Bot ID を受け付けません（<a href="04-invariants.md">dispatch の不変条件</a>を参照）。<br>
      • 翻訳はテキストとキャプションのみを扱い、純粋なメディアや数字約物のみのメッセージは送信しません。
    </td>
  </tr>
  <tr>
    <td><nobr>🛡️ <b>認証 / 広告 / 連投が無反応</b></nobr></td>
    <td>
      • <b>既定で無効</b>：<code>/antiraid enable</code>、<code>/ad_detect enable</code>、<code>/flood_control enable</code> で個別に有効化してください。<br>
      • <b>管理者権限不足</b>：Bot にメッセージ削除やメンバー制限の管理者権限が必要です。<br>
      • <b>モデル未設定</b>：広告検出には <code>config/dynamic/agent.json</code> に <code>agent.ad_detect</code> が必要です。
    </td>
  </tr>
  <tr>
    <td><nobr>💀 <b>プロセス停止、メニューも出ない</b></nobr></td>
    <td>
      • <b>サービス稼働</b>：<code>systemctl status &lt;サービス名&gt;</code> でプロセスを確認してください。<br>
      • <b>設定エラーによる終了</b>：データルートの <code>logs/&lt;日付&gt;.json</code> を確認。無効な設定があると起動時に停止しエラー箇所を出力します。<br>
      • <b>トークン競合（409 エラー）</b>：ログに 409 がある場合、同トークンで他インスタンスが稼働中か Webhook が設定されています（<a href="07-operations.md#起動失敗の調査">07 運用</a> 参照）。
    </td>
  </tr>
</tbody>
</table>

---

## 通知の口調を切り替えるには？

- `config/static/bot.json` 内で `atmosphere` を `mesugaki`（雌小鬼版）または `normal`（通常版）に明示設定すると、人設に応じた既定値より優先され、再起動後に反映されます。
- `atmosphere` を省略した場合、プロジェクトルートに `prompt/persona.md` があれば全グループの通知とメニューは通常版、なければ雌小鬼版になります。
- 通知の口調はシステム通知のスタイルのみを変更し、AI 雑談の System Prompt 人設は変更しません。

---

## 画像ライブラリが起動拒否される、または画像収集で重複排除されない原因は？

- **ファイル規約**：専用画像ライブラリディレクトリ（`assets.json` の `random_h_image_dir`）には、**バイナリコンテンツの SHA-256**（64 文字の小文字 16 進数）で命名された通常の画像のみを配置できます。
- **起動時インターセプト**：ディレクトリ内にサブディレクトリ、シンボリックリンク、隠しファイル、または残存した一時ファイルが存在する場合、起動前チェックにより起動が拒否されます。サービスを停止してバックアップを取得した上で、[07 運用とトラブルシューティング](07-operations.md) に従って残存ファイルをクリーンアップしてください。
- **重複排除ロジック**：画像収集時の重複排除はダウンロード後のハッシュ計算段階で行われます。ライブラリ内に同一ハッシュのファイルが既に存在する場合は直接スキップされ、収録済みである旨が案内されます。手動で配置された画像は、同一のダイジェスト名と拡張子を保持している場合のみ重複排除にヒットします。

---

## 定時タスクが再起動後に再送信されるのはなぜか？

- `just_once` の実行記録はメモリ内にのみ保持されるため、再起動時に再登録されます。完了したタスクは `config/dynamic/cron.json` から削除してください。
- `rand_cron` のランダム時刻も再起動後に指定範囲内で再抽選されます。停止期間中にスキップされたタスクは補填送信されません。
- 固定画像は 1–10 項目の配列として設定する必要があります。`cron.json` 内の相対パスは一律で実行時データルートからの相対パスとして解決されます（`./` 接頭辞は不要です）。

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
    <td>指定プロバイダが音声合成に未対応です（現在は <code>google</code> と <code>openai</code> のみ対応）。</td>
  </tr>
  <tr>
    <td><code>synthesis failed</code> / <code>timed out</code></td>
    <td>モデル呼び出しの失敗またはタイムアウト。OpenAI 互換では <code>audio/speech</code> と <code>opus</code> が必須です。</td>
  </tr>
  <tr>
    <td><code>not an Ogg Opus stream</code> / <code>not an MP3 stream</code></td>
    <td>返却された音声ストリーム形式が要求プロトコルと一致していません。</td>
  </tr>
  <tr>
    <td><code>daily limit reached</code></td>
    <td>当日の音声クォータを使い切りました。24 時間ウィンドウ経過後にリセットされます。</td>
  </tr>
</tbody>
</table>

### クォータと割り当てメカニズム

- `/send` と `cron.json` は独立した **`daily_reserve_quota`**（デフォルト 25 回）を共有し、`reserveCount` に記録されます。
- AI 雑談は残りの **`daily_limit - daily_reserve_quota`**（デフォルト 75 回）を独立して使用し、`agentCount` に記録されます。
- 両者のクォータは相互に隔離されており、互いの枠を圧迫しません。クォータは 24 時間のローリングウィンドウ満了後にリセットされます。

### 個人チャット `/send` のフォーマット要件

個人チャットでの音声リクエストは、**メッセージ全体がコードブロック**であり、かつ `type` が `tts` と指定されている必要があります：
```json
{ "type": "tts", "tone": "ツンデレ", "text": "合成するセリフ" }
```
コードブロックの内容は JSONC として解析され、コメントと末尾のカンマを使用できます。解析に失敗するか `type` が `"tts"` でない場合は、元のメッセージを対象グループにコピーします。`type` が `"tts"` でもフィールドが不正な場合は、スーパー管理者の個別チャットに形式の案内を送り、対象グループには転送しません。

---

## 音声の長さ・温度・記憶はどう設定するか？

| エントリ | セリフ上限 (UTF-16) | 送信成功後の AI 記憶 |
| :--- | :---: | :--- |
| **AI `send_voice`** | 64 | セリフを記録 |
| **個人チャット `/send` TTS** | 256 | 自動記録なし |
| **cron `send_voice`** | 256 | 自動記録なし |

- **口調と長さ**：`tone`（口調）の上限は一律で 64 UTF-16 コード単位です。空白は正規化後に検証されます。音声レスポンスのサイズ上限は 8 MiB です。
- **声色とスタイル**：
  - 声色は `agent.tts.voice` で設定します。
  - 基本スタイルは任意の `agent.tts.style` で設定し（ホットリロード対応）、省略時は内蔵の `TTS_DEFAULT_STYLE` を使用します。
  - 送信時に `<基本スタイル>; 细节: <口調>` として自動結合されます。AI 返信の合成では両者の間に読み上げ言語指定が入ります（下記のセリフの言語を参照）。
  - `speech_protocol: "xai"` プロトコルは `style` フィールドをサポートしておらず、口調も送信されません。
- **セリフの言語**：AI `send_voice` のセリフの言語は任意の `agent.tts.bot_language` で設定します（`en` / `zh` / `ja`、省略時 `ja`。ホットリロード対応で、次の返信から反映）。`send_voice`・`send_message` のツール説明と system prompt 内のボイス重複規則を切り替え、AI 返信の合成リクエストでは基本スタイルの後ろにその言語の読み上げ言語指定を追加します（`<基本スタイル>; <読み上げ言語>; 细节: <口調>`。文言は `VOICE_LANGUAGE_PROMPTS` の `speechLanguageStyle` に登録）。`style` は変えず、`/send` と cron のセリフと合成リクエストにも影響しません。xai プロトコルで API に送る合成言語は引き続き `language` で決まります。
- **セリフの言語と一緒に変える設定**：AI 返信の読み上げ言語指定は `bot_language` に従って自動で追加されます。`voice`・`style`・`prompt/voice_tool.md` は追従しません。`bot_language` を変えるときは次を推奨します。
  - `style` をその言語で書いた声質説明に書き換えます（省略時の `TTS_DEFAULT_STYLE` は日本語の説明）。`style` は `/send` と cron でも使うため声質だけを書き、読み上げ言語は書きません。`/send` と cron で言語を指定したい場合はそれぞれの口調に書きます。`style` を変えても不自然な場合は、その言語向けに設計した音色（`voice`）に替えます。
  - `prompt/voice_tool.md` を配置している場合は、セリフの言語・セリフ例・口調例を同じ言語に変えます。このファイルは変更後に再起動が必要です。
  - xai プロトコルにはスタイル欄がないため、読み上げ言語指定も口調も送りません。`language` を変えます。
- **ボイスツール説明のカスタマイズ**：プロジェクトルートに `prompt/voice_tool.md` を配置すると、再起動後に `bot_language` の値にかかわらず、その本文で `send_voice` のツール説明全体を置き換えます。`text` / `tone` 引数の説明とボイス重複規則は引き続き `bot_language` で選ばれます。空文字または不正な UTF-8 の場合は起動を拒否し、ホットリロードはしません。
- **サンプリング温度**：Gemini 音声サンプリングの温度はソースコード定数 `GEMINI_SPEECH_TEMPERATURE`（現在は `1`）によって固定されています。

---

## サードパーティゲートウェイ（Cloudflare AI Gateway 等）経由で Google モデルを呼び出すには？

1. **Endpoint の設定**：該当する能力の `base_url` をゲートウェイのアドレスに変更します。例：
   `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/google-ai-studio`
2. **認証ヘッダーの付加**：同一能力の下に `headers` を設定します。例：
   ```json
   "headers": {
     "cf-aig-authorization": "Bearer <token>"
   }
   ```
3. **API Key の保持**：`api_key` には引き続き必須の Google API キーを設定します。`headers` は `provider: "google"` の場合にのみ有効であり、機密値はログ出力時に自動的にマスキングされます。
4. **ルーティングの網羅**：テキスト、画像認識、画像生成は generateContent ルーティングを通過し、音声合成は Interactions API を通過します。設定完了後、`/send` 経由で音声を 1 回送信してゲートウェイの導通を確認できます。

---

<div align="center">

[← 前のページ：10 パフォーマンスベンチマーク](10-performance.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#11-よくある質問)

</div>
