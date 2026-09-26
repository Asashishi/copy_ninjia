# 10 よくある質問

<p align="center">
  <a href="../cn/10-faq.md">简体中文</a> · <a href="../en/10-faq.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 ドキュメントホーム</a> · <a href="09-performance.md">← 前のページ：09 パフォーマンスベンチマーク</a> · <b>次のページ：なし →</b>
</p>

---

Bot のプロセスは動いているのにグループで反応がないときは、次のリストを順に確認してください。BotFather の設定と機能ごとに必要なグループ管理者権限は [プロジェクト README](README.md#botfather-setup) にあります。

## Bot は動いているのに、なぜ返信しないのか

- **グループで何を送っても反応しない**：そのグループでまだ `/init enable` を実行していません。未初期化のグループでは、スーパー管理者の `/init` 以外のメッセージとコマンドは通知なしで無視されます。
- **通常メッセージに反応しない（copy、翻訳、AI の返答、Q&A が動かない）**：Bot が通常メッセージを受信できていません。プライバシーモードが有効のままで Bot が管理者でないか、プライバシーモードを変更した後に Bot をグループから外して追加し直していません。
- **AI が話さない**：
  - `config/dynamic/agent.json` で AI を設定し、そのグループで `/ai_chat enable`（既定は無効）を実行する必要があります。
  - 確実に反応するのは Bot への返信と @ メンションだけです。それ以外は確率による割り込みで、`/quiet` の間は割り込みません。反応が起きても、話すかどうかは AI がペルソナに従って決めます。
  - そのグループで `/copy` 実行中は、AI と他の自発的な動作が止まります。
  - 反応が密集するとレート制限がかかり、制限通知はグループごとのクールダウンがあるため毎回は送られません。
- **Bot に個人チャットしても反応しない**：個人チャットはスーパー管理者の `/send` だけを受け付け、他のスラッシュコマンドは無視します。AI との会話はグループでだけ行います。
- **通知が表示されてしばらくすると消える**：コマンド検証の失敗、権限拒否、用法の案内、操作の結果は送信成功の 30 秒後に自動削除されます。長期保持の例外は [08 コマンドリファレンス](08-commands.md) を参照してください。
- **`@Bot` で運勢の候補が出ない**：Inline Mode が有効になっていません。
- **`/咬` のような動作コマンドに反応しない**：中国語 1〜2 文字だけを受け付けます。全体で 90 秒ごとに最大 450 回まで応答し、超過分は通知なしで破棄します。
- **別の Bot のメッセージが翻訳・copy されない、または届いたり届かなかったりする**：Bot-to-Bot Communication Mode を有効にしてください（[BotFather の設定](README.md#botfather-setup) を参照）。翻訳は文字とキャプションを扱い、文字のない画像・スタンプ・ファイルは送らず、描画されるコマンド `/コマンド` を含むメッセージはまるごと飛ばします。
- **参加認証、広告検出、連投ミュートが動かない**：3 つとも既定で無効です。それぞれ `/antiraid enable`、`/ad_detect enable`、`/flood_control enable` を実行し、Bot が管理者で[グループ内の管理者権限](README.md#botfather-setup) の表の権限を持っていることを確認してください。広告検出には `config/dynamic/agent.json` での広告検出能力の設定も必要です。
- **まったく反応せず、コマンドメニューもない**：まずプロセスが動いているか確認します（`systemctl status <サービス名>`、`journalctl -u <サービス名>`）。エラーログは data root の `logs/<日付>.json` にあります。設定や状態の書き誤りがあるとプロセスは起動段階で終了し、ログにファイルパスとフィールドを記録します。ログに `Error fetching Telegram updates` がエラーコード 409 付きで繰り返し出る場合は、同じ token で別のインスタンスが更新を取得しているか webhook が設定されており、プロセスは終了します。調査手順は [07 運用とトラブルシューティング](07-operations.md#起動失敗の調査) を参照してください。

## 通知の口調を変えるには？

`config/static/bot.json` の `atmosphere` を `mesugaki`（既定）か `normal` に設定し、再起動します。`/prompt config` で専用 AI 人設を持つ群は普通の通知とメニューを優先し、`/prompt remove` で Bot 設定の口調に戻ります。通知口調は AI プロンプトを変更しません。

## 画像庫が起動を拒否する、または重複を検出しないのは？

専用画像庫は内容 SHA-256 名の通常画像だけを受け付けます。サブディレクトリ・ファイルへのリンク・隠しファイル・残存一時ファイルは起動を拒否します。停止・バックアップ後に [運用手順](07-operations.md) に従って確認し、移行 manifest は画像庫に入れないでください。収集時には既存画像の内容を読まず、ダウンロード後に計算した保存先名を照合します。手動画像は同じ内容ダイジェスト名と保存拡張子のときだけ一致します。cron の独立ランダム画像ディレクトリには通常のファイル名を使えます。

## 定時タスクが再起動後にまた送信されるのは？

`just_once` の実行記録はメモリ内だけなので、再起動で再登録します。完了したタスクは `config/dynamic/cron.json` から削除してください。`rand_cron` の待機もリセットされ、停止中の予定は補送しません。固定画像は 1〜10 項目の配列、ランダム画像の `path` はディレクトリ文字列です。cron の相対パスはプロジェクトルート、専用画像庫はデータルート基準です。例は [配置設定](../../config_example/README/ja.md#cronjson) を参照してください。

## 定時ボイスや `/send` のボイスが送られないのは？

どちらも `config/dynamic/agent.json` の `agent.tts` を使って AI Worker 上で合成します。`cron.json` が `tts` なしで `send_voice` を使うと起動を拒否し、稼働中にこの組み合わせになる変更はホットリロードで拒否されエラーログに残ります。`/send` のボイス依頼には「音声合成が未設定」と返します。`tts` を設定しても失敗する場合はログを確認してください。`speech synthesis failed: worker unavailable` は AI Worker が動いていないこと（`stickers.json`、`mood.json`、`prompt/persona.md` も必要）、`tts unsupported` は選んだ provider が音声合成を実装していないこと（現在は `google` のみ）、`synthesis failed` / `timed out` は主にモデル側の問題を示し、`daily limit reached` は 1 日のボイス上限を使い切ったことを示します。3 つの入口は 1 日 `agent.tts.daily_limit`（既定 100）回を共有し、AI は最大 `daily_limit - daily_reserve_quota`（既定 75）回まで使えます。計数窓は窓内の最初の request から始まって 24 時間後に数え直し、`memory/global/state.json` の `ttsUsage` に記録します。この 2 つの値は `agent.tts` で調整でき、変更は hot reload ですぐ反映され、使用済み回数はリセットされません。`/send` のボイス依頼はメッセージ全体を 1 つのコードブロックにし、`type` を `tts` にする必要があります。それ以外は通常のメッセージとして転送されます。項目と上限は [設定説明](../../config_example/README/ja.md#cronjson) と [08 コマンド](08-commands.md) を参照してください。

## 音声の長さ・温度・記憶はどう設定しますか？

| 入口 | セリフ上限 | 送信成功後の AI 記憶 |
| :--- | ---: | :--- |
| AI `send_voice` | 64 | セリフを記録 |
| 個人チャットの `/send` TTS | 256 | 自動記録なし |
| cron `send_voice` | 256 | 自動記録なし |

長さは UTF-16 コード単位で数え、`tone` の上限は共通で 64 です。空白の正規化後に検証します。`/send` の超過は書式案内を返します。cron の不正なフィールドは起動を拒否し、hot reload では更新全体を拒否してログに記録します。音声レスポンスには別途 8 MiB の上限があり、文字数は音声の秒数を保証しません。

音色は `config/dynamic/agent.json` の `agent.tts.voice`、基本スタイルは任意の `agent.tts.style` で設定し、どちらも hot reload に対応します。style は trim 後に空でない文字列が必要です。省略または削除すると [`GEMINI_SPEECH_STYLE`](../../packages/consts/aiChat/gemini.ts) を使います。3 つの入口で共用し、口調を指定すると `<基本スタイル>; 细节: <口調>` として連結します。新しい request は再読み込み後の設定を使い、発行済み request は元の snapshot を保持します。サンプリング温度は引き続きソース定数 `GEMINI_SPEECH_TEMPERATURE`（現在 `1.25`）で決まり、温度変更には再ビルドまたはソース版サービスの再起動が必要です。

## サードパーティ gateway（Cloudflare AI Gateway など）経由で Google モデルを呼ぶには？

該当する能力の `base_url` を gateway が提供する Google AI Studio endpoint に変更し（Cloudflare では `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/google-ai-studio`）、gateway が要求する認証 header を同じ能力の `headers` に書きます。例：`{ "cf-aig-authorization": "Bearer <token>" }`。`api_key` は引き続き必須の Google key です。`headers` は `provider` が `google` の能力でのみ有効で、値はログ上で資格情報として秘匿されます。文字・画像認識・画像生成は generateContent、音声合成は Interactions API を通り、どちらにも `headers` が付きます。gateway が Interactions API を転送するかは gateway 次第なので、設定後はまず `/send` でボイスを 1 件送って確認してください。項目の規則は [設定説明](../../config_example/README/ja.md#agentjson) を参照してください。

---

<div align="center">

[← 前のページ：09 パフォーマンスベンチマーク](09-performance.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#10-よくある質問)

</div>
