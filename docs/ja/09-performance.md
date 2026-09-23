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

**直近の全量ベンチマーク** · Bun 1.4.2 · 3 ラウンドの平均 · 2026-09-23T15:04:08Z · プロセス起動からローカル復元完了まで 342.3 ms · グループメッセージ 1 件を基本ディスパッチする 136.9 ns · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 800.7 µs / 1,164 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 2.91 ms / 323 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-09-23T15:04:08Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 392,931,405 |
| プロセス読み込み | 164.08 MiB |
| プロセス書き込み | 174.21 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 194.05 MiB |
| 読み込みシステムコール | 51,567 |
| 書き込みシステムコール | 86,233 |
| モックルート使用量 | 15.51 MiB |
| モックルートファイル数 | 113 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 114.4 ms | ±7.0% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 15.40 ms | ±24.6% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 586.6 µs | ±1.1% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.51 ms | ±12.7% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 3.69 ms | ±1.3% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 649.8 µs | ±1.2% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 192.1 ms | ±4.3% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 885.7 µs | ±95.6% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 342.3 ms | ±5.7% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 111.61 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 136.9 ns | 7,309,220 回/s | 91.41 MiB | 6.23 KiB | ±1.8% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 92.5 ns | 10,879,647 回/s | 89.15 MiB | 21.81 KiB | ±7.9% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 19.9 ns | 51,919,700 回/s | 75.94 MiB | 22.23 KiB | ±17.2% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 24.0 ns | 46,308,368 回/s | 76.26 MiB | 21.74 KiB | ±28.4% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 34.8 ns | 28,723,522 回/s | 77.58 MiB | 21.51 KiB | ±3.2% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.9 ns | 1,170,563,094 回/s | 74.55 MiB | 21.74 KiB | ±1.5% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 50.3 ns | 19,931,497 回/s | 77.54 MiB | 20.02 KiB | ±4.8% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.0 ns | 250,404,908 回/s | 75.71 MiB | 21.10 KiB | ±3.9% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 9.9 ns | 100,951,949 回/s | 76.13 MiB | 19.86 KiB | ±0.8% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 44.1 ns | 22,813,882 回/s | 77.38 MiB | 21.39 KiB | ±7.7% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 7.994 µs | 126,048 回/s | 99.69 MiB | 21.39 KiB | ±9.0% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 99.9 ns | 10,016,040 回/s | 83.00 MiB | 23.97 KiB | ±2.5% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 23.7 ns | 42,271,062 回/s | 85.08 MiB | 22.83 KiB | ±0.8% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 50.0 ns | 20,036,276 回/s | 78.07 MiB | 22.39 KiB | ±3.6% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 264.0 ns | 3,795,266 回/s | 116.14 MiB | 5.63 MiB | ±4.6% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 303.0 ns | 3,308,700 回/s | 141.16 MiB | 20.63 KiB | ±4.9% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.3 ns | 234,686,431 回/s | 76.05 MiB | 20.95 KiB | ±1.4% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 4.409 µs | 226,834 回/s | 86.42 MiB | 23.81 KiB | ±0.6% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 93.6 ns | 10,688,798 回/s | 120.95 MiB | 24.66 KiB | ±2.0% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 275.3 ns | 3,632,612 回/s | 87.01 MiB | 23.93 KiB | ±0.3% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 37.23 µs | 26,866 回/s | 99.16 MiB | 23.06 KiB | ±1.3% |
| 返信参照を抽出する<br><code>reply-reference</code> | 18.1 ns | 55,414,814 回/s | 87.61 MiB | 23.74 KiB | ±2.2% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 47.3 ns | 21,127,220 回/s | 91.52 MiB | 21.96 KiB | ±1.6% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 6.2 ns | 192,321,544 回/s | 75.80 MiB | 21.71 KiB | ±46.1% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 37.3 ns | 26,834,238 回/s | 85.01 MiB | 20.50 KiB | ±4.1% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 22.5 ns | 44,493,817 回/s | 75.89 MiB | 20.35 KiB | ±5.6% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 16.5 ns | 60,777,220 回/s | 77.98 MiB | 22.24 KiB | ±4.5% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 73.2 ns | 13,690,025 回/s | 77.24 MiB | 21.89 KiB | ±3.9% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 915 回/s | 1.09 ms | 993.7 µs | 1.45 ms | 9.78 ms | 915 レコード/s | 3.91 MiB | ±2.4% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 141 回/s | 7.11 ms | 7.77 ms | 12.12 ms | 18.97 ms | 18,015 レコード/s | 21.42 MiB | ±3.3% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 673 回/s | 1.49 ms | 1.38 ms | 1.90 ms | 9.62 ms | 673 レコード/s | 3.15 MiB | ±3.8% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 609 回/s | 1.65 ms | 1.47 ms | 2.38 ms | 7.92 ms | 609 レコード/s | 3.13 MiB | ±6.2% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 596 回/s | 1.68 ms | 1.45 ms | 2.82 ms | 9.60 ms | 596 レコード/s | 3.13 MiB | ±4.5% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 346 回/s | 2.89 ms | 2.61 ms | 4.25 ms | 11.43 ms | 346 レコード/s | 5.55 MiB | ±2.3% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 828 回/s | 1.21 ms | 1.09 ms | 1.57 ms | 16.73 ms | 828 レコード/s | 4.16 MiB | ±5.6% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 323 回/s | 3.09 ms | 2.91 ms | 4.25 ms | 6.18 ms | 323 レコード/s | 1.83 MiB | ±2.4% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 1,164 回/s | 853.3 µs | 800.7 µs | 1.19 ms | 1.98 ms | 1,164 レコード/s | 1.33 KiB | ±4.6% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 29,671,829 回/s | 269.7 ns | 0 B | 5.73 KiB | ±2.1% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 20,019 回/s | 6.40 ms | 56.29 MiB | 43.67 KiB | ±2.1% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 76,788 回/s | 104.2 µs | 5.29 MiB | 79.55 KiB | ±0.8% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 16,649 回/s | 480.7 µs | 2.92 MiB | 296.44 KiB | ±2.2% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 17,699 回/s | 7.23 ms | 73.14 MiB | 185.46 KiB | ±1.9% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 14,691 回/s | 8.71 ms | 9.73 MiB | 211.48 KiB | ±0.8% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 17.6 ns | 56,722,649 回/s | 87.43 MiB | 22.40 KiB | ±1.5% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 36.2 ns | 27,617,311 回/s | 77.46 MiB | 23.36 KiB | ±1.5% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 18.2 ns | 55,199,165 回/s | 84.55 MiB | 25.27 KiB | ±4.6% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 116.4 ms | 1.70 MiB | 4.96 KiB | ±0.5% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 15.75 ms | 0 B | -5.01 KiB | ±9.2% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク) · [次のページ：10 よくある質問 →](10-faq.md)

</div>
