# 10 パフォーマンスベンチマーク

<p align="center">
  <a href="../cn/10-performance.md">简体中文</a> · <a href="../en/10-performance.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 ドキュメントホーム</a> · <a href="09-commands.md">← 前のページ：09 コマンドと挙動リファレンス</a> · <a href="11-faq.md">次のページ：11 よくある質問 →</a>
</p>

---

本ページの計測値は `bun run perf:full -- --write-doc` が生成し、リリースごとに再実行して一括で上書きします。
下の 2 つのマーカーに挟まれた内容は手で編集せず、3 言語のうち 1 つだけを更新することもしないでください。

同じ実行は**構造化レポート全文**を、repository root の版管理された `performance-result.json` の
`fullSuite.lastRun` にも書き込みます。本ページは人間向けの表示、その JSON は同じ計測値の機械可読な
記録です（環境、セクション、項目ごとの平均と変動係数まで全て）。両者は同一の switch が書き出すため、
片方だけが古くなることはありません。

ベンチマークはリリース時と明示的な指示があったときにのみ実行し、`bun run check` には含めません。
ホットパスの GC/RSS/JIT ハードゲートは `bun run perf:hot-path-gate` が担当します。
[05 開発フローと品質ゲート](05-dev-workflow.md) を参照してください。

個別 scenario と `bun run perf:disk-transport` の実行方法・測定境界は [05 開発フロー](05-dev-workflow.md#個別シナリオと伝送ストレス検証) を参照してください。個別出力と hot-path gate は個別に記録し、以下の全量基準の生成 block を置き換えません。

<!-- performance-benchmark:start -->

**直近の全量ベンチマーク** · Bun 1.4.2 · 3 ラウンドの平均 · 2026-10-05T12:21:36Z · プロセス起動からローカル復元完了まで 387.5 ms · グループメッセージ 1 件を基本ディスパッチする 148.9 ns · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 201.3 µs / 4,249 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 1.89 ms / 470 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-10-05T12:21:36Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 392,931,453 |
| プロセス読み込み | 182.37 MiB |
| プロセス書き込み | 185.20 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 234.42 MiB |
| 読み込みシステムコール | 53,124 |
| 書き込みシステムコール | 243,671 |
| モックルート使用量 | 15.43 MiB |
| モックルートファイル数 | 120 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 108.6 ms | ±9.2% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 13.43 ms | ±3.2% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 664.5 µs | ±0.5% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.23 ms | ±6.9% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 4.85 ms | ±1.2% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 669.6 µs | ±6.5% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 244.8 ms | ±1.5% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 308.4 µs | ±14.1% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 387.5 ms | ±2.4% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 119.68 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 148.9 ns | 6,715,858 回/s | 97.63 MiB | 4.14 KiB | ±1.8% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 99.9 ns | 10,080,855 回/s | 97.14 MiB | 20.10 KiB | ±8.3% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 16.6 ns | 60,494,360 回/s | 82.96 MiB | 20.32 KiB | ±4.5% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 29.6 ns | 33,776,648 回/s | 83.94 MiB | 20.21 KiB | ±1.4% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 33.2 ns | 30,128,428 回/s | 85.17 MiB | 18.86 KiB | ±1.5% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.9 ns | 1,154,750,399 回/s | 82.41 MiB | 21.30 KiB | ±3.0% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 48.0 ns | 20,849,019 回/s | 84.67 MiB | 19.49 KiB | ±2.3% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 3.9 ns | 254,780,753 回/s | 82.93 MiB | 20.33 KiB | ±4.1% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 10.1 ns | 98,814,012 回/s | 83.38 MiB | 19.56 KiB | ±4.5% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 42.7 ns | 23,439,723 回/s | 85.35 MiB | 18.58 KiB | ±0.9% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 1.104 µs | 907,117 回/s | 109.31 MiB | 15.93 KiB | ±3.3% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 93.4 ns | 10,713,471 回/s | 90.89 MiB | 20.13 KiB | ±1.5% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 42.3 ns | 23,674,745 回/s | 93.00 MiB | 19.95 KiB | ±3.9% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 51.1 ns | 19,579,035 回/s | 84.96 MiB | 22.41 KiB | ±1.7% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 267.8 ns | 3,749,668 回/s | 121.86 MiB | 5.63 MiB | ±6.5% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 324.6 ns | 3,081,744 回/s | 148.67 MiB | 19.63 KiB | ±1.6% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.3 ns | 233,947,160 回/s | 83.11 MiB | 19.21 KiB | ±1.5% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 2.166 µs | 461,742 回/s | 95.28 MiB | 21.81 KiB | ±0.4% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 32.5 ns | 30,804,543 回/s | 90.48 MiB | 13.64 KiB | ±2.0% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 280.9 ns | 3,563,962 回/s | 97.09 MiB | 21.46 KiB | ±3.6% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 37.94 µs | 26,357 回/s | 109.11 MiB | 20.85 KiB | ±0.6% |
| 返信参照を抽出する<br><code>reply-reference</code> | 26.8 ns | 37,396,089 回/s | 96.30 MiB | 22.04 KiB | ±2.1% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 47.4 ns | 21,097,084 回/s | 105.56 MiB | 19.57 KiB | ±2.5% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 7.8 ns | 150,486,838 回/s | 83.83 MiB | 20.54 KiB | ±33.9% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 37.5 ns | 26,698,332 回/s | 92.58 MiB | 19.20 KiB | ±1.4% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 22.0 ns | 45,572,333 回/s | 83.08 MiB | 19.42 KiB | ±6.0% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 17.0 ns | 58,920,008 回/s | 85.31 MiB | 20.84 KiB | ±3.4% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 74.0 ns | 13,558,883 回/s | 84.26 MiB | 20.28 KiB | ±5.4% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。cron 音声の行も音声合成モデルと Telegram を固定応答（約 11 秒の WAV）に置き換え、Base64 デコード、WAV 解析、Opus エンコードと送信境界を含む。本番では合成は AI Worker 上で動くが、この行は同一プロセス内で両側をつなぎ、スレッド間の受け渡しは含まない。cron.json の行は途中変更の費用だけを測り、タスクは実行しない。タスク表は本番の上限（128 タスク、各 16 アクション、ローカルソースはデータルート相対）とし、1 タスクを変更するたびに本番と同じ順序でホットリロード対象の 6 ファイルを読み取って厳密に解析し（ローカルソースを 1 件ずつ確認）、スナップショットを置き換えてタスク名でスケジューラを突き合わせる。書き換えと保存はデプロイ側の作業なので計測せず、ファイル監視のデバウンス待ち、その後の広告検出と AI チャットの可用性の再判定、ホットリロードのログも含まない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 755 回/s | 1.33 ms | 1.17 ms | 2.00 ms | 9.30 ms | 755 レコード/s | 3.91 MiB | ±8.3% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 293 回/s | 3.41 ms | 3.06 ms | 5.29 ms | 16.80 ms | 37,554 レコード/s | 21.42 MiB | ±3.1% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 604 回/s | 1.66 ms | 1.56 ms | 2.33 ms | 8.63 ms | 604 レコード/s | 3.15 MiB | ±4.7% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 473 回/s | 2.17 ms | 1.87 ms | 3.07 ms | 20.80 ms | 473 レコード/s | 3.13 MiB | ±15.6% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 478 回/s | 2.10 ms | 1.88 ms | 2.90 ms | 14.64 ms | 478 レコード/s | 3.13 MiB | ±7.0% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 264 回/s | 3.81 ms | 3.26 ms | 6.18 ms | 29.49 ms | 264 レコード/s | 5.55 MiB | ±7.0% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 665 回/s | 1.54 ms | 1.41 ms | 2.09 ms | 10.00 ms | 665 レコード/s | 4.16 MiB | ±16.4% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 470 回/s | 2.13 ms | 1.89 ms | 3.37 ms | 9.19 ms | 470 レコード/s | 1.20 MiB | ±2.4% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 4,249 回/s | 233.0 µs | 201.3 µs | 391.2 µs | 723.3 µs | 4,249 レコード/s | 0 B | ±4.1% |
| cron send_voice：音声 1 件を合成・エンコードして送信する（通信を除く）<br><code>cron-send-voice</code> | 5 回/s | 197.6 ms | 196.6 ms | 204.0 ms | 212.0 ms | 5 レコード/s | 0 B | ±1.1% |
| cron.json のタスク 1 件を途中変更：ホットリロードと再スケジュール（上限規模のタスク表）<br><code>cron-config-reload</code> | 7 回/s | 135.3 ms | 134.2 ms | 140.5 ms | 146.5 ms | 7 レコード/s | 7.31 MiB | ±0.6% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 30,023,058 回/s | 266.6 ns | 0 B | 5.65 KiB | ±2.0% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 34,847 回/s | 3.80 ms | 56.32 MiB | 42.21 KiB | ±17.4% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 75,231 回/s | 106.4 µs | 5.29 MiB | 71.72 KiB | ±1.3% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 13,533 回/s | 591.4 µs | 34.01 MiB | 290.40 KiB | ±2.1% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 41,103 回/s | 3.15 ms | 73.14 MiB | 134.49 KiB | ±10.5% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 14,640 回/s | 8.74 ms | 12.63 MiB | 419.49 KiB | ±1.0% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 18.2 ns | 54,990,615 回/s | 94.12 MiB | 21.67 KiB | ±4.3% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 36.8 ns | 27,157,169 回/s | 85.19 MiB | 22.17 KiB | ±0.8% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 18.6 ns | 53,998,715 回/s | 93.19 MiB | 23.78 KiB | ±6.1% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 123.7 ms | 1.40 MiB | 6.43 KiB | ±4.3% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 17.05 ms | 0 B | -3.60 KiB | ±6.2% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：09 コマンドと挙動リファレンス](09-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#10-パフォーマンスベンチマーク) · [次のページ：11 よくある質問 →](11-faq.md)

</div>
