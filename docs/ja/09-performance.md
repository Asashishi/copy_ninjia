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

**直近の全量ベンチマーク** · Bun 1.4.2 · 3 ラウンドの平均 · 2026-09-22T14:15:02Z · プロセス起動からローカル復元完了まで 326.7 ms · グループメッセージ 1 件を基本ディスパッチする 139.2 ns · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 800.6 µs / 1,180 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 2.98 ms / 309 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-09-22T14:15:02Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 392,931,405 |
| プロセス読み込み | 164.38 MiB |
| プロセス書き込み | 173.94 MiB |
| ブロックデバイス読み込み | 2.67 KiB |
| ブロックデバイス書き込み | 193.70 MiB |
| 読み込みシステムコール | 51,843 |
| 書き込みシステムコール | 86,196 |
| モックルート使用量 | 14.80 MiB |
| モックルートファイル数 | 113 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 105.9 ms | ±3.4% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 13.59 ms | ±21.0% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 536.0 µs | ±2.5% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.42 ms | ±1.5% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 3.57 ms | ±2.8% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 668.1 µs | ±0.3% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 185.6 ms | ±3.5% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 1.55 ms | ±53.5% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 326.7 ms | ±3.9% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 110.23 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 139.2 ns | 7,186,143 回/s | 90.30 MiB | 6.08 KiB | ±1.5% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 82.9 ns | 12,089,854 回/s | 89.73 MiB | 19.81 KiB | ±4.6% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 15.8 ns | 63,210,611 回/s | 76.21 MiB | 22.30 KiB | ±3.8% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 28.4 ns | 35,160,035 回/s | 76.44 MiB | 23.25 KiB | ±0.4% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 34.1 ns | 29,375,348 回/s | 78.15 MiB | 22.01 KiB | ±3.2% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.9 ns | 1,159,581,653 回/s | 74.98 MiB | 21.38 KiB | ±0.3% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 48.8 ns | 20,519,641 回/s | 77.78 MiB | 20.74 KiB | ±4.8% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.0 ns | 251,547,571 回/s | 76.07 MiB | 21.59 KiB | ±3.7% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 11.7 ns | 85,670,503 回/s | 76.65 MiB | 20.08 KiB | ±3.5% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 41.8 ns | 23,944,810 回/s | 77.69 MiB | 19.52 KiB | ±1.4% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 8.254 µs | 121,193 回/s | 99.12 MiB | 21.86 KiB | ±1.9% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 93.5 ns | 10,701,453 回/s | 83.33 MiB | 24.13 KiB | ±2.8% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 24.0 ns | 41,662,601 回/s | 84.84 MiB | 22.63 KiB | ±4.4% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 49.4 ns | 20,262,698 回/s | 78.27 MiB | 21.95 KiB | ±1.2% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 260.7 ns | 3,838,114 回/s | 121.74 MiB | 5.63 MiB | ±2.2% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 306.7 ns | 3,261,361 回/s | 135.60 MiB | 20.66 KiB | ±1.6% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.3 ns | 230,359,538 回/s | 76.07 MiB | 20.05 KiB | ±3.8% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 4.529 µs | 220,920 回/s | 86.39 MiB | 23.12 KiB | ±2.4% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 99.7 ns | 10,084,019 回/s | 120.65 MiB | 24.96 KiB | ±7.3% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 280.2 ns | 3,570,726 回/s | 88.68 MiB | 24.82 KiB | ±2.3% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 37.09 µs | 26,962 回/s | 101.60 MiB | 22.66 KiB | ±0.4% |
| 返信参照を抽出する<br><code>reply-reference</code> | 18.2 ns | 55,040,254 回/s | 87.33 MiB | 24.41 KiB | ±0.6% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 46.9 ns | 21,327,809 回/s | 91.33 MiB | 22.78 KiB | ±2.2% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 4.1 ns | 247,120,911 回/s | 75.52 MiB | 20.18 KiB | ±3.9% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 39.8 ns | 25,148,949 回/s | 84.76 MiB | 20.83 KiB | ±3.6% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 21.9 ns | 45,621,105 回/s | 76.18 MiB | 19.84 KiB | ±2.3% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 16.4 ns | 61,039,145 回/s | 78.40 MiB | 22.55 KiB | ±2.2% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 72.0 ns | 13,887,285 回/s | 77.18 MiB | 21.20 KiB | ±1.8% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 784 回/s | 1.28 ms | 1.09 ms | 1.98 ms | 11.30 ms | 784 レコード/s | 3.91 MiB | ±5.2% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 146 回/s | 6.85 ms | 7.67 ms | 11.30 ms | 21.14 ms | 18,686 レコード/s | 21.42 MiB | ±0.6% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 676 回/s | 1.48 ms | 1.38 ms | 1.91 ms | 6.22 ms | 676 レコード/s | 3.15 MiB | ±0.7% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 586 回/s | 1.72 ms | 1.51 ms | 3.32 ms | 7.47 ms | 586 レコード/s | 3.13 MiB | ±9.0% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 631 回/s | 1.59 ms | 1.43 ms | 2.33 ms | 8.66 ms | 631 レコード/s | 3.13 MiB | ±6.7% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 349 回/s | 2.87 ms | 2.58 ms | 4.21 ms | 14.70 ms | 349 レコード/s | 5.55 MiB | ±2.8% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 852 回/s | 1.17 ms | 1.08 ms | 1.54 ms | 8.68 ms | 852 レコード/s | 4.16 MiB | ±1.4% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 309 回/s | 3.24 ms | 2.98 ms | 5.27 ms | 8.44 ms | 309 レコード/s | 1.83 MiB | ±1.5% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 1,180 回/s | 839.2 µs | 800.6 µs | 1.09 ms | 1.58 ms | 1,180 レコード/s | 0 B | ±0.9% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 30,475,261 回/s | 262.5 ns | 0 B | 5.57 KiB | ±0.3% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 19,833 回/s | 6.46 ms | 56.29 MiB | 30.50 KiB | ±1.6% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 74,149 回/s | 107.9 µs | 5.29 MiB | 85.92 KiB | ±1.7% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 17,086 回/s | 468.6 µs | 2.92 MiB | 295.55 KiB | ±2.9% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 17,807 回/s | 7.19 ms | 73.14 MiB | 188.86 KiB | ±0.1% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 14,608 回/s | 8.76 ms | 9.73 MiB | 220.40 KiB | ±1.1% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 16.9 ns | 59,122,864 回/s | 88.01 MiB | 23.22 KiB | ±3.4% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 38.6 ns | 26,080,144 回/s | 77.64 MiB | 23.90 KiB | ±8.8% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 19.6 ns | 51,243,931 回/s | 84.19 MiB | 25.26 KiB | ±6.5% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 122.0 ms | 1.65 MiB | 5.04 KiB | ±1.2% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 15.75 ms | 0 B | -5.74 KiB | ±9.8% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク) · [次のページ：10 よくある質問 →](10-faq.md)

</div>
