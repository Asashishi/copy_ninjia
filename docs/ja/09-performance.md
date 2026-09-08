# 09 パフォーマンスベンチマーク

<p align="center">
  <a href="../cn/09-performance.md">简体中文</a> · <a href="../en/09-performance.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 ドキュメントホーム</a> · <a href="08-commands.md">← 前のページ：08 コマンドと挙動リファレンス</a> · <b>次のページ：なし →</b>
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

個別 scenario と `diskTransport` の実行方法・測定境界は [05 開発フロー](05-dev-workflow.md#個別シナリオと伝送ストレス検証) を参照してください。個別出力と hot-path gate は個別に記録し、以下の全量基準の生成 block を置き換えません。

<!-- performance-benchmark:start -->

**直近の全量ベンチマーク** · Bun 1.4.2 · 3 ラウンドの平均 · 2026-09-08T13:33:04Z · プロセス起動からローカル復元完了まで 529.4 ms · グループメッセージ 1 件を基本ディスパッチする 1.230 µs · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 1.16 ms / 779 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 5.69 ms / 146 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| カーネル | linux 6.8.0-138-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-09-08T13:33:04Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 392,931,405 |
| プロセス読み込み | 121.45 MiB |
| プロセス書き込み | 178.32 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 197.80 MiB |
| 読み込みシステムコール | 40,077 |
| 書き込みシステムコール | 85,286 |
| モックルート使用量 | 15.55 MiB |
| モックルートファイル数 | 163 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 147.4 ms | ±14.1% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 33.27 ms | ±19.5% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 903.5 µs | ±7.4% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 2.34 ms | ±20.4% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 9.57 ms | ±32.1% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 1.04 ms | ±21.8% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 312.3 ms | ±6.8% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 3.02 ms | ±55.2% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 529.4 ms | ±5.4% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 111.56 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 1.230 µs | 813,757 回/s | 77.97 MiB | 25.77 KiB | ±3.0% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 134.0 ns | 7,502,813 回/s | 84.90 MiB | 21.35 KiB | ±7.6% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 15.4 ns | 64,930,702 回/s | 72.70 MiB | 22.05 KiB | ±2.4% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 34.9 ns | 28,643,257 回/s | 73.07 MiB | 22.99 KiB | ±2.3% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 46.4 ns | 21,696,857 回/s | 74.61 MiB | 22.00 KiB | ±7.8% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.8 ns | 1,290,536,328 回/s | 71.84 MiB | 23.49 KiB | ±22.2% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 73.7 ns | 14,137,783 回/s | 74.21 MiB | 22.54 KiB | ±21.5% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.3 ns | 234,035,791 回/s | 71.75 MiB | 23.47 KiB | ±2.7% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 12.7 ns | 78,681,547 回/s | 72.76 MiB | 19.95 KiB | ±1.7% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 45.4 ns | 22,039,234 回/s | 74.14 MiB | 17.94 KiB | ±2.4% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 11.45 µs | 87,855 回/s | 96.36 MiB | 21.24 KiB | ±7.2% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 112.5 ns | 8,892,968 回/s | 79.79 MiB | 24.59 KiB | ±2.6% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 53.5 ns | 21,143,458 回/s | 79.86 MiB | 21.62 KiB | ±31.2% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 53.3 ns | 18,818,722 回/s | 74.75 MiB | 21.46 KiB | ±4.7% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 392.5 ns | 2,588,290 回/s | 117.82 MiB | 5.64 MiB | ±13.0% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 451.4 ns | 2,216,075 回/s | 136.42 MiB | 21.38 KiB | ±1.8% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.9 ns | 208,258,516 回/s | 73.05 MiB | 21.20 KiB | ±13.8% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 5.260 µs | 190,713 回/s | 82.86 MiB | 24.61 KiB | ±5.7% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 115.9 ns | 8,631,271 回/s | 115.25 MiB | 24.30 KiB | ±1.5% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 333.1 ns | 3,002,949 回/s | 98.83 MiB | 25.60 KiB | ±1.4% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 54.47 µs | 18,363 回/s | 95.48 MiB | 22.45 KiB | ±1.6% |
| 返信参照を抽出する<br><code>reply-reference</code> | 25.6 ns | 39,057,901 回/s | 81.72 MiB | 23.08 KiB | ±3.7% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 68.7 ns | 14,627,149 回/s | 83.40 MiB | 22.34 KiB | ±6.6% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 3.9 ns | 255,823,611 回/s | 76.49 MiB | 21.95 KiB | ±3.2% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 33.1 ns | 30,682,382 回/s | 80.75 MiB | 22.82 KiB | ±12.8% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 24.4 ns | 41,027,695 回/s | 72.49 MiB | 21.89 KiB | ±5.6% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 12.3 ns | 81,779,946 回/s | 75.57 MiB | 21.33 KiB | ±7.1% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 91.3 ns | 11,047,670 回/s | 73.74 MiB | 21.75 KiB | ±9.2% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 364 回/s | 2.78 ms | 2.04 ms | 6.86 ms | 21.35 ms | 364 レコード/s | 3.91 MiB | ±11.3% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 74 回/s | 13.45 ms | 13.47 ms | 23.80 ms | 39.88 ms | 9,515 レコード/s | 20.53 MiB | ±2.5% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 285 回/s | 3.63 ms | 3.02 ms | 7.79 ms | 19.10 ms | 285 レコード/s | 3.15 MiB | ±17.9% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 274 回/s | 3.73 ms | 3.03 ms | 8.51 ms | 22.16 ms | 274 レコード/s | 3.13 MiB | ±14.1% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 318 回/s | 3.15 ms | 2.55 ms | 6.10 ms | 21.71 ms | 318 レコード/s | 3.13 MiB | ±5.4% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 175 回/s | 5.77 ms | 4.66 ms | 11.73 ms | 29.82 ms | 175 レコード/s | 11.72 MiB | ±10.9% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 380 回/s | 2.64 ms | 2.08 ms | 4.97 ms | 22.64 ms | 380 レコード/s | 4.16 MiB | ±5.9% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 146 回/s | 6.89 ms | 5.69 ms | 14.94 ms | 30.23 ms | 146 レコード/s | 1.83 MiB | ±7.7% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 779 回/s | 1.27 ms | 1.16 ms | 2.31 ms | 2.92 ms | 779 レコード/s | 0 B | ±4.2% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 25,797,027 回/s | 310.2 ns | 0 B | 5.81 KiB | ±1.9% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 10,583 回/s | 12.11 ms | 61.90 MiB | 31.05 KiB | ±3.0% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 39,481 回/s | 202.9 µs | 4.86 MiB | 87.03 KiB | ±3.7% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 12,105 回/s | 662.0 µs | 2.70 MiB | 290.02 KiB | ±4.1% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 9,277 回/s | 13.80 ms | 67.73 MiB | 173.25 KiB | ±1.7% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 8,807 回/s | 14.56 ms | 9.00 MiB | 203.04 KiB | ±4.2% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 20.8 ns | 50,166,073 回/s | 79.36 MiB | 22.50 KiB | ±21.6% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 39.0 ns | 25,757,920 回/s | 73.69 MiB | 22.96 KiB | ±6.5% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 21.7 ns | 48,238,469 回/s | 80.56 MiB | 25.24 KiB | ±22.7% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 177.9 ms | 1.92 MiB | 4.96 KiB | ±10.1% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 31.66 ms | 0 B | -4.97 KiB | ±3.4% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク)

</div>
