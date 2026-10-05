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

**直近の全量ベンチマーク** · Bun 1.4.2 · 3 ラウンドの平均 · 2026-10-05T02:36:01Z · プロセス起動からローカル復元完了まで 396.4 ms · グループメッセージ 1 件を基本ディスパッチする 149.0 ns · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 210.7 µs / 4,029 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 1.85 ms / 476 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-10-05T02:36:01Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 392,931,453 |
| プロセス読み込み | 182.45 MiB |
| プロセス書き込み | 185.20 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 234.41 MiB |
| 読み込みシステムコール | 53,288 |
| 書き込みシステムコール | 243,665 |
| モックルート使用量 | 14.77 MiB |
| モックルートファイル数 | 121 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 119.3 ms | ±2.9% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 12.44 ms | ±7.4% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 863.2 µs | ±14.8% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.55 ms | ±17.5% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 5.28 ms | ±5.3% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 720.3 µs | ±1.7% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 241.6 ms | ±1.4% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 292.1 µs | ±4.8% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 396.4 ms | ±1.0% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 119.05 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 149.0 ns | 6,715,225 回/s | 97.93 MiB | 6.56 KiB | ±3.0% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 103.1 ns | 9,778,867 回/s | 96.98 MiB | 20.11 KiB | ±8.9% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 16.4 ns | 61,227,459 回/s | 83.50 MiB | 20.41 KiB | ±3.9% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 29.5 ns | 33,914,683 回/s | 83.56 MiB | 20.16 KiB | ±3.3% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 35.1 ns | 28,460,229 回/s | 84.80 MiB | 20.15 KiB | ±0.7% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.9 ns | 1,158,199,066 回/s | 82.32 MiB | 21.30 KiB | ±1.8% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 52.4 ns | 19,087,141 回/s | 85.60 MiB | 18.74 KiB | ±1.5% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.1 ns | 245,262,975 回/s | 82.84 MiB | 21.12 KiB | ±4.8% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 11.1 ns | 90,593,710 回/s | 83.34 MiB | 18.43 KiB | ±6.7% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 42.1 ns | 23,749,318 回/s | 84.92 MiB | 18.43 KiB | ±1.1% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 1.208 µs | 828,490 回/s | 110.52 MiB | 19.39 KiB | ±2.8% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 92.3 ns | 10,848,127 回/s | 90.29 MiB | 21.25 KiB | ±3.7% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 44.8 ns | 22,315,330 回/s | 93.21 MiB | 19.79 KiB | ±0.9% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 52.7 ns | 19,113,733 回/s | 85.70 MiB | 20.43 KiB | ±8.4% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 265.1 ns | 3,781,861 回/s | 122.48 MiB | 5.63 MiB | ±4.9% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 361.6 ns | 2,772,113 回/s | 146.65 MiB | 18.60 KiB | ±5.0% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.5 ns | 223,482,953 回/s | 83.94 MiB | 19.41 KiB | ±6.0% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 2.297 µs | 435,516 回/s | 96.21 MiB | 22.22 KiB | ±1.6% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 33.3 ns | 30,032,747 回/s | 90.54 MiB | 13.60 KiB | ±3.5% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 305.6 ns | 3,280,176 回/s | 97.97 MiB | 21.29 KiB | ±4.8% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 44.06 µs | 22,697 回/s | 111.75 MiB | 20.46 KiB | ±0.4% |
| 返信参照を抽出する<br><code>reply-reference</code> | 38.7 ns | 27,202,702 回/s | 96.28 MiB | 21.84 KiB | ±22.3% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 46.8 ns | 21,554,637 回/s | 106.47 MiB | 20.01 KiB | ±9.1% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 6.1 ns | 195,235,397 回/s | 83.37 MiB | 19.49 KiB | ±46.6% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 38.9 ns | 25,717,130 回/s | 92.97 MiB | 21.65 KiB | ±1.9% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 21.9 ns | 45,608,441 回/s | 82.77 MiB | 19.83 KiB | ±2.4% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 16.7 ns | 59,745,866 回/s | 86.07 MiB | 20.61 KiB | ±2.0% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 77.0 ns | 13,004,640 回/s | 84.45 MiB | 20.03 KiB | ±3.5% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。cron 音声の行も音声合成モデルと Telegram を固定応答（約 11 秒の WAV）に置き換え、Base64 デコード、WAV 解析、Opus エンコードと送信境界を含む。本番では合成は AI Worker 上で動くが、この行は同一プロセス内で両側をつなぎ、スレッド間の受け渡しは含まない。cron.json の行は途中変更の費用だけを測り、タスクは実行しない。タスク表は本番の上限（128 タスク、各 16 アクション、ローカルソースはデータルート相対）とし、1 タスクを変更するたびに本番と同じ順序でホットリロード対象の 6 ファイルを読み取って厳密に解析し（ローカルソースを 1 件ずつ確認）、スナップショットを置き換えてタスク名でスケジューラを突き合わせる。書き換えと保存はデプロイ側の作業なので計測せず、ファイル監視のデバウンス待ち、その後の広告検出と AI チャットの可用性の再判定、ホットリロードのログも含まない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 816 回/s | 1.24 ms | 1.08 ms | 1.88 ms | 10.95 ms | 816 レコード/s | 3.91 MiB | ±9.7% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 310 回/s | 3.23 ms | 3.12 ms | 6.01 ms | 15.50 ms | 39,616 レコード/s | 21.42 MiB | ±1.4% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 753 回/s | 1.33 ms | 1.20 ms | 1.91 ms | 6.07 ms | 753 レコード/s | 3.15 MiB | ±2.4% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 674 回/s | 1.48 ms | 1.33 ms | 2.40 ms | 6.38 ms | 674 レコード/s | 3.13 MiB | ±1.3% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 678 回/s | 1.47 ms | 1.35 ms | 2.04 ms | 7.12 ms | 678 レコード/s | 3.13 MiB | ±0.8% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 344 回/s | 2.91 ms | 2.64 ms | 4.23 ms | 11.86 ms | 344 レコード/s | 5.55 MiB | ±1.0% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 859 回/s | 1.16 ms | 1.08 ms | 1.58 ms | 7.12 ms | 859 レコード/s | 4.16 MiB | ±2.7% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 476 回/s | 2.10 ms | 1.85 ms | 3.18 ms | 11.32 ms | 476 レコード/s | 1.20 MiB | ±1.6% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 4,029 回/s | 246.1 µs | 210.7 µs | 388.9 µs | 647.0 µs | 4,029 レコード/s | 0 B | ±5.2% |
| cron send_voice：音声 1 件を合成・エンコードして送信する（通信を除く）<br><code>cron-send-voice</code> | 5 回/s | 199.3 ms | 197.1 ms | 209.6 ms | 215.2 ms | 5 レコード/s | 0 B | ±1.3% |
| cron.json のタスク 1 件を途中変更：ホットリロードと再スケジュール（上限規模のタスク表）<br><code>cron-config-reload</code> | 7 回/s | 143.9 ms | 143.3 ms | 151.2 ms | 153.9 ms | 7 レコード/s | 7.31 MiB | ±0.2% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 28,398,068 回/s | 283.4 ns | 0 B | 5.92 KiB | ±7.5% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 41,692 回/s | 3.07 ms | 56.31 MiB | 41.17 KiB | ±0.9% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 66,395 回/s | 120.6 µs | 5.29 MiB | 73.89 KiB | ±2.7% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 13,314 回/s | 600.9 µs | 34.01 MiB | 282.59 KiB | ±0.9% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 62,977 回/s | 2.03 ms | 73.14 MiB | 134.33 KiB | ±1.9% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 18,846 回/s | 6.79 ms | 12.63 MiB | 421.11 KiB | ±0.8% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 18.2 ns | 55,045,813 回/s | 94.80 MiB | 22.11 KiB | ±2.1% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 36.8 ns | 27,170,682 回/s | 85.64 MiB | 22.05 KiB | ±2.5% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 19.0 ns | 52,896,760 回/s | 93.30 MiB | 24.03 KiB | ±6.5% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 126.9 ms | 1.90 MiB | 4.96 KiB | ±2.2% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 25.45 ms | 0 B | -4.88 KiB | ±11.6% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：09 コマンドと挙動リファレンス](09-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#10-パフォーマンスベンチマーク) · [次のページ：11 よくある質問 →](11-faq.md)

</div>
