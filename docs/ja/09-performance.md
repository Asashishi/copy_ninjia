# 09 パフォーマンスベンチマーク

<p align="center">
  <a href="../cn/09-performance.md">简体中文</a> · <a href="../en/09-performance.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 ドキュメントホーム</a> · <a href="08-commands.md">← 前のページ：08 コマンドと挙動リファレンス</a> · <a href="10-faq.md">次のページ：10 よくある質問 →</a>
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

**直近の全量ベンチマーク** · Bun 1.4.2 · 3 ラウンドの平均 · 2026-09-30T12:31:08Z · プロセス起動からローカル復元完了まで 327.4 ms · グループメッセージ 1 件を基本ディスパッチする 141.7 ns · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 199.4 µs / 4,292 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 1.73 ms / 501 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-09-30T12:31:08Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 392,931,453 |
| プロセス読み込み | 179.77 MiB |
| プロセス書き込み | 185.20 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 234.42 MiB |
| 読み込みシステムコール | 52,558 |
| 書き込みシステムコール | 243,645 |
| モックルート使用量 | 14.25 MiB |
| モックルートファイル数 | 120 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 109.0 ms | ±1.4% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 11.83 ms | ±3.5% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 623.5 µs | ±0.7% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.18 ms | ±0.2% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 4.72 ms | ±1.9% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 627.0 µs | ±2.3% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 185.7 ms | ±1.5% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 914.8 µs | ±87.4% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 327.4 ms | ±0.1% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 108.46 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 141.7 ns | 7,059,857 回/s | 91.77 MiB | 4.20 KiB | ±0.6% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 94.8 ns | 10,569,471 回/s | 93.16 MiB | 20.26 KiB | ±4.8% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 15.8 ns | 63,297,880 回/s | 77.88 MiB | 21.78 KiB | ±2.5% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 28.5 ns | 35,113,704 回/s | 77.73 MiB | 22.38 KiB | ±1.0% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 33.5 ns | 29,880,415 回/s | 79.71 MiB | 21.34 KiB | ±1.0% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.9 ns | 1,172,205,848 回/s | 76.81 MiB | 21.75 KiB | ±0.6% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 48.7 ns | 20,560,220 回/s | 79.80 MiB | 20.69 KiB | ±4.0% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.1 ns | 243,455,340 回/s | 77.13 MiB | 21.38 KiB | ±6.1% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 9.9 ns | 101,541,649 回/s | 77.72 MiB | 20.73 KiB | ±1.4% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 41.5 ns | 24,124,681 回/s | 78.77 MiB | 20.20 KiB | ±0.7% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 1.042 µs | 960,597 回/s | 102.80 MiB | 17.77 KiB | ±2.4% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 93.4 ns | 10,724,112 回/s | 84.97 MiB | 23.30 KiB | ±3.3% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 24.2 ns | 41,315,144 回/s | 86.88 MiB | 22.96 KiB | ±1.1% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 49.4 ns | 20,229,423 回/s | 79.50 MiB | 21.56 KiB | ±1.7% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 257.4 ns | 3,912,124 回/s | 115.33 MiB | 5.63 MiB | ±8.2% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 302.7 ns | 3,305,850 回/s | 137.76 MiB | 17.60 KiB | ±2.9% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.3 ns | 232,693,919 回/s | 78.12 MiB | 19.91 KiB | ±2.3% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 2.202 µs | 454,143 回/s | 88.71 MiB | 23.29 KiB | ±1.2% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 96.7 ns | 10,338,922 回/s | 122.90 MiB | 24.28 KiB | ±0.5% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 278.7 ns | 3,590,176 回/s | 89.21 MiB | 23.93 KiB | ±2.4% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 36.31 µs | 27,543 回/s | 101.10 MiB | 20.91 KiB | ±0.6% |
| 返信参照を抽出する<br><code>reply-reference</code> | 27.1 ns | 36,959,849 回/s | 90.96 MiB | 22.96 KiB | ±3.3% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 48.9 ns | 20,437,269 回/s | 99.56 MiB | 20.87 KiB | ±0.8% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 8.0 ns | 144,489,562 回/s | 78.13 MiB | 22.56 KiB | ±32.6% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 38.0 ns | 26,309,112 回/s | 85.98 MiB | 19.40 KiB | ±1.7% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 21.8 ns | 45,945,895 回/s | 77.34 MiB | 21.15 KiB | ±1.9% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 16.3 ns | 61,558,801 回/s | 79.74 MiB | 21.15 KiB | ±3.0% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 74.9 ns | 13,386,339 回/s | 78.55 MiB | 22.00 KiB | ±5.5% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。cron 音声の行も音声合成モデルと Telegram を固定応答（約 11 秒の WAV）に置き換え、Base64 デコード、WAV 解析、Opus エンコードと送信境界を含む。本番では合成は AI Worker 上で動くが、この行は同一プロセス内で両側をつなぎ、スレッド間の受け渡しは含まない。cron.json の行は途中変更の費用だけを測り、タスクは実行しない。タスク表は本番の上限（128 タスク、各 16 アクション、ローカルソースはデータルート相対）とし、1 タスクを変更するたびに本番と同じ順序でホットリロード対象の 6 ファイルを読み取って厳密に解析し（ローカルソースを 1 件ずつ確認）、スナップショットを置き換えてタスク名でスケジューラを突き合わせる。書き換えと保存はデプロイ側の作業なので計測せず、ファイル監視のデバウンス待ち、その後の広告検出と AI チャットの可用性の再判定、ホットリロードのログも含まない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 944 回/s | 1.06 ms | 977.7 µs | 1.30 ms | 8.72 ms | 944 レコード/s | 3.91 MiB | ±2.3% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 337 回/s | 2.96 ms | 2.93 ms | 4.79 ms | 16.04 ms | 43,186 レコード/s | 21.42 MiB | ±2.3% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 834 回/s | 1.20 ms | 1.12 ms | 1.51 ms | 5.57 ms | 834 レコード/s | 3.15 MiB | ±5.0% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 729 回/s | 1.37 ms | 1.27 ms | 1.81 ms | 7.99 ms | 729 レコード/s | 3.13 MiB | ±2.5% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 766 回/s | 1.30 ms | 1.23 ms | 1.66 ms | 6.32 ms | 766 レコード/s | 3.13 MiB | ±0.9% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 376 回/s | 2.66 ms | 2.33 ms | 4.42 ms | 13.38 ms | 376 レコード/s | 5.55 MiB | ±2.4% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 901 回/s | 1.11 ms | 1.04 ms | 1.38 ms | 8.73 ms | 901 レコード/s | 4.16 MiB | ±0.9% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 501 回/s | 2.01 ms | 1.73 ms | 3.88 ms | 9.18 ms | 501 レコード/s | 1.20 MiB | ±8.2% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 4,292 回/s | 230.6 µs | 199.4 µs | 365.7 µs | 525.8 µs | 4,292 レコード/s | 0 B | ±2.6% |
| cron send_voice：音声 1 件を合成・エンコードして送信する（通信を除く）<br><code>cron-send-voice</code> | 5 回/s | 187.9 ms | 187.8 ms | 192.4 ms | 200.5 ms | 5 レコード/s | 0 B | ±1.4% |
| cron.json のタスク 1 件を途中変更：ホットリロードと再スケジュール（上限規模のタスク表）<br><code>cron-config-reload</code> | 7 回/s | 136.0 ms | 134.5 ms | 142.2 ms | 144.6 ms | 7 レコード/s | 7.31 MiB | ±1.2% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 31,260,586 回/s | 256.0 ns | 0 B | 7.56 KiB | ±1.3% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 43,309 回/s | 2.96 ms | 56.32 MiB | 43.14 KiB | ±2.2% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 75,183 回/s | 106.5 µs | 5.29 MiB | 78.79 KiB | ±2.9% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 13,128 回/s | 609.9 µs | 34.01 MiB | 297.12 KiB | ±2.9% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 61,936 回/s | 2.07 ms | 73.14 MiB | 137.80 KiB | ±1.8% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 18,468 回/s | 6.94 ms | 12.63 MiB | 437.83 KiB | ±3.3% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 15.7 ns | 64,135,912 回/s | 87.92 MiB | 22.39 KiB | ±7.5% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 36.0 ns | 27,799,526 回/s | 78.85 MiB | 23.21 KiB | ±0.9% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 17.7 ns | 56,580,058 回/s | 86.84 MiB | 25.19 KiB | ±5.5% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 119.8 ms | 1.75 MiB | 4.89 KiB | ±1.7% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 16.45 ms | 0 B | -3.53 KiB | ±6.5% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク) · [次のページ：10 よくある質問 →](10-faq.md)

</div>
