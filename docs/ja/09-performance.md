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

個別 scenario と `bun run perf:disk-transport` の実行方法・測定境界は [05 開発フロー](05-dev-workflow.md#個別シナリオと伝送ストレス検証) を参照してください。個別出力と hot-path gate は個別に記録し、以下の全量基準の生成 block を置き換えません。

<!-- performance-benchmark:start -->

**直近の全量ベンチマーク** · Bun 1.4.2 · 3 ラウンドの平均 · 2026-09-18T07:42:14Z · プロセス起動からローカル復元完了まで 328.6 ms · グループメッセージ 1 件を基本ディスパッチする 151.0 ns · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 825.1 µs / 1,143 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 2.98 ms / 303 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-09-18T07:42:14Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 392,931,405 |
| プロセス読み込み | 164.13 MiB |
| プロセス書き込み | 173.94 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 193.70 MiB |
| 読み込みシステムコール | 51,566 |
| 書き込みシステムコール | 86,157 |
| モックルート使用量 | 14.19 MiB |
| モックルートファイル数 | 113 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 101.0 ms | ±0.4% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 13.84 ms | ±6.8% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 559.8 µs | ±11.8% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.41 ms | ±3.1% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 4.83 ms | ±2.1% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 719.6 µs | ±2.5% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 193.1 ms | ±2.3% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 925.1 µs | ±86.2% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 328.6 ms | ±1.7% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 110.58 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 151.0 ns | 6,711,983 回/s | 87.59 MiB | 7.95 KiB | ±12.1% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 88.8 ns | 11,295,580 回/s | 89.67 MiB | 20.77 KiB | ±5.8% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 16.4 ns | 60,812,575 回/s | 75.39 MiB | 21.21 KiB | ±1.0% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 28.8 ns | 34,794,594 回/s | 75.67 MiB | 21.21 KiB | ±1.9% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 33.9 ns | 29,499,407 回/s | 76.60 MiB | 21.07 KiB | ±1.1% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.9 ns | 1,174,397,249 回/s | 74.15 MiB | 22.01 KiB | ±0.8% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 52.5 ns | 19,237,200 回/s | 76.79 MiB | 20.79 KiB | ±10.5% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.1 ns | 243,763,986 回/s | 74.67 MiB | 21.65 KiB | ±4.3% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 11.6 ns | 86,037,955 回/s | 75.62 MiB | 20.28 KiB | ±0.3% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 41.7 ns | 24,059,897 回/s | 76.98 MiB | 20.08 KiB | ±6.6% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 9.131 µs | 109,990 回/s | 98.24 MiB | 22.45 KiB | ±6.5% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 98.6 ns | 10,156,584 回/s | 82.06 MiB | 23.67 KiB | ±3.8% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 27.0 ns | 37,024,994 回/s | 83.35 MiB | 22.56 KiB | ±2.2% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 51.6 ns | 19,370,920 回/s | 77.07 MiB | 21.91 KiB | ±0.7% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 278.3 ns | 3,594,521 回/s | 120.81 MiB | 5.63 MiB | ±2.2% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 331.1 ns | 3,022,166 回/s | 138.33 MiB | 21.14 KiB | ±2.5% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.3 ns | 232,705,462 回/s | 75.09 MiB | 20.97 KiB | ±0.8% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 4.521 µs | 221,221 回/s | 85.16 MiB | 23.02 KiB | ±1.0% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 99.7 ns | 10,046,900 回/s | 119.21 MiB | 24.52 KiB | ±3.6% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 283.0 ns | 3,534,651 回/s | 86.61 MiB | 25.14 KiB | ±1.5% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 40.42 µs | 24,768 回/s | 97.76 MiB | 22.76 KiB | ±3.3% |
| 返信参照を抽出する<br><code>reply-reference</code> | 19.9 ns | 50,439,977 回/s | 86.37 MiB | 24.33 KiB | ±5.3% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 58.4 ns | 17,120,564 回/s | 87.73 MiB | 20.94 KiB | ±1.2% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 4.3 ns | 233,134,511 回/s | 81.59 MiB | 21.88 KiB | ±0.3% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 38.5 ns | 26,048,841 回/s | 83.73 MiB | 19.62 KiB | ±4.8% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 21.6 ns | 46,416,243 回/s | 75.15 MiB | 22.68 KiB | ±3.1% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 16.4 ns | 61,074,477 回/s | 77.17 MiB | 22.70 KiB | ±1.6% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 75.0 ns | 13,340,005 回/s | 76.07 MiB | 22.81 KiB | ±0.8% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 892 回/s | 1.12 ms | 1.03 ms | 1.55 ms | 6.83 ms | 892 レコード/s | 3.91 MiB | ±1.2% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 129 回/s | 7.74 ms | 8.66 ms | 12.98 ms | 20.02 ms | 16,535 レコード/s | 21.42 MiB | ±2.7% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 610 回/s | 1.64 ms | 1.43 ms | 2.65 ms | 11.57 ms | 610 レコード/s | 3.15 MiB | ±1.9% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 600 回/s | 1.67 ms | 1.51 ms | 2.50 ms | 8.33 ms | 600 レコード/s | 3.13 MiB | ±0.7% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 606 回/s | 1.65 ms | 1.52 ms | 2.36 ms | 7.82 ms | 606 レコード/s | 3.13 MiB | ±0.8% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 342 回/s | 2.92 ms | 2.68 ms | 4.08 ms | 11.17 ms | 342 レコード/s | 5.55 MiB | ±1.5% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 840 回/s | 1.19 ms | 1.10 ms | 1.54 ms | 8.01 ms | 840 レコード/s | 4.16 MiB | ±1.9% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 303 回/s | 3.30 ms | 2.98 ms | 4.90 ms | 11.12 ms | 303 レコード/s | 1.83 MiB | ±2.2% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 1,143 回/s | 867.1 µs | 825.1 µs | 1.19 ms | 1.52 ms | 1,143 レコード/s | 0 B | ±1.0% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 28,138,314 回/s | 284.4 ns | 0 B | 7.41 KiB | ±1.8% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 17,991 回/s | 7.12 ms | 56.29 MiB | 31.47 KiB | ±1.3% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 68,405 回/s | 117.0 µs | 5.29 MiB | 80.15 KiB | ±1.5% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 14,957 回/s | 535.9 µs | 2.92 MiB | 296.99 KiB | ±4.3% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 16,144 回/s | 7.93 ms | 73.14 MiB | 187.46 KiB | ±1.2% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 13,723 回/s | 9.33 ms | 9.73 MiB | 224.01 KiB | ±1.0% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 18.1 ns | 55,257,361 回/s | 86.41 MiB | 22.47 KiB | ±0.7% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 36.6 ns | 27,345,325 回/s | 76.41 MiB | 23.02 KiB | ±4.7% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 18.1 ns | 56,148,988 回/s | 83.29 MiB | 24.44 KiB | ±11.7% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 126.7 ms | 1.78 MiB | 4.89 KiB | ±1.5% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 22.67 ms | 0 B | -4.98 KiB | ±6.7% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク)

</div>
