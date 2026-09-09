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

**直近の全量ベンチマーク** · Bun 1.4.2 · 3 ラウンドの平均 · 2026-09-09T15:22:44Z · プロセス起動からローカル復元完了まで 507.4 ms · グループメッセージ 1 件を基本ディスパッチする 1.256 µs · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 1.13 ms / 794 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 5.97 ms / 151 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| カーネル | linux 6.8.0-138-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-09-09T15:22:44Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 392,931,405 |
| プロセス読み込み | 121.50 MiB |
| プロセス書き込み | 178.32 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 197.80 MiB |
| 読み込みシステムコール | 40,107 |
| 書き込みシステムコール | 85,190 |
| モックルート使用量 | 17.43 MiB |
| モックルートファイル数 | 161 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 151.7 ms | ±1.3% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 21.44 ms | ±10.3% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 773.3 µs | ±12.9% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 2.05 ms | ±8.8% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 7.39 ms | ±5.4% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 978.5 µs | ±12.9% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 300.2 ms | ±2.0% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 658.9 µs | ±17.6% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 507.4 ms | ±1.7% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 113.76 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 1.256 µs | 799,627 回/s | 79.44 MiB | 24.69 KiB | ±6.7% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 164.8 ns | 6,227,105 回/s | 86.06 MiB | 22.48 KiB | ±15.2% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 18.5 ns | 55,705,692 回/s | 72.80 MiB | 22.05 KiB | ±17.5% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 39.1 ns | 25,980,079 回/s | 72.97 MiB | 22.26 KiB | ±12.9% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 49.3 ns | 20,313,713 回/s | 74.14 MiB | 21.84 KiB | ±4.7% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.9 ns | 1,174,232,908 回/s | 71.76 MiB | 20.87 KiB | ±17.5% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 51.4 ns | 19,462,300 回/s | 74.03 MiB | 22.66 KiB | ±2.4% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.3 ns | 233,634,818 回/s | 72.33 MiB | 22.00 KiB | ±6.5% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 13.5 ns | 73,985,213 回/s | 72.89 MiB | 20.79 KiB | ±4.1% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 47.8 ns | 21,025,770 回/s | 74.22 MiB | 20.97 KiB | ±7.1% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 13.68 µs | 73,209 回/s | 97.52 MiB | 20.19 KiB | ±3.6% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 119.2 ns | 8,408,366 回/s | 79.55 MiB | 24.36 KiB | ±4.7% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 49.2 ns | 22,286,783 回/s | 79.53 MiB | 22.10 KiB | ±26.9% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 53.8 ns | 19,390,570 回/s | 74.54 MiB | 19.63 KiB | ±22.0% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 456.5 ns | 2,196,522 回/s | 118.25 MiB | 5.63 MiB | ±5.2% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 489.7 ns | 2,050,665 回/s | 133.60 MiB | 20.77 KiB | ±6.4% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.3 ns | 231,341,483 回/s | 73.00 MiB | 21.52 KiB | ±3.0% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 5.470 µs | 183,261 回/s | 82.61 MiB | 24.23 KiB | ±4.9% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 124.3 ns | 8,120,457 回/s | 114.88 MiB | 23.19 KiB | ±9.3% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 338.2 ns | 2,958,584 回/s | 98.59 MiB | 26.87 KiB | ±2.6% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 55.66 µs | 17,968 回/s | 95.36 MiB | 23.96 KiB | ±0.9% |
| 返信参照を抽出する<br><code>reply-reference</code> | 34.4 ns | 30,777,383 回/s | 80.65 MiB | 23.28 KiB | ±25.0% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 68.1 ns | 14,714,536 回/s | 86.21 MiB | 21.36 KiB | ±5.3% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 4.5 ns | 221,366,798 回/s | 76.39 MiB | 22.10 KiB | ±4.1% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 33.2 ns | 30,231,285 回/s | 80.73 MiB | 20.14 KiB | ±7.2% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 26.7 ns | 37,469,522 回/s | 72.60 MiB | 21.56 KiB | ±2.7% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 12.9 ns | 77,744,168 回/s | 76.66 MiB | 20.73 KiB | ±3.5% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 80.4 ns | 12,525,216 回/s | 72.91 MiB | 21.02 KiB | ±8.4% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 364 回/s | 2.75 ms | 2.10 ms | 6.01 ms | 25.01 ms | 364 レコード/s | 3.91 MiB | ±2.3% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 72 回/s | 14.01 ms | 14.38 ms | 24.47 ms | 81.15 ms | 9,154 レコード/s | 20.53 MiB | ±4.4% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 306 回/s | 3.29 ms | 2.65 ms | 6.91 ms | 20.03 ms | 306 レコード/s | 3.15 MiB | ±8.9% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 182 回/s | 5.55 ms | 4.44 ms | 13.09 ms | 40.87 ms | 182 レコード/s | 3.13 MiB | ±10.6% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 307 回/s | 3.25 ms | 2.68 ms | 6.00 ms | 19.37 ms | 307 レコード/s | 3.13 MiB | ±3.1% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 175 回/s | 5.70 ms | 4.89 ms | 11.84 ms | 20.17 ms | 175 レコード/s | 11.72 MiB | ±2.4% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 376 回/s | 2.66 ms | 2.10 ms | 4.76 ms | 40.65 ms | 376 レコード/s | 4.16 MiB | ±1.9% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 151 回/s | 6.65 ms | 5.97 ms | 11.59 ms | 20.92 ms | 151 レコード/s | 1.83 MiB | ±5.3% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 794 回/s | 1.25 ms | 1.13 ms | 1.86 ms | 3.48 ms | 794 レコード/s | 0 B | ±2.8% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 25,270,116 回/s | 316.9 ns | 0 B | 7.75 KiB | ±3.0% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 10,193 回/s | 12.60 ms | 61.90 MiB | 29.25 KiB | ±6.0% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 42,787 回/s | 187.1 µs | 4.86 MiB | 77.45 KiB | ±2.3% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 12,499 回/s | 641.5 µs | 2.70 MiB | 285.15 KiB | ±4.7% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 10,291 回/s | 12.45 ms | 67.73 MiB | 176.09 KiB | ±2.3% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 8,820 回/s | 14.52 ms | 9.00 MiB | 220.52 KiB | ±1.9% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 16.8 ns | 59,812,011 回/s | 82.29 MiB | 23.51 KiB | ±5.3% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 37.1 ns | 27,068,489 回/s | 73.84 MiB | 23.26 KiB | ±5.7% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 18.3 ns | 54,935,568 回/s | 80.72 MiB | 24.50 KiB | ±7.9% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 154.1 ms | 2.21 MiB | 4.96 KiB | ±3.2% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 33.18 ms | 0 B | -4.97 KiB | ±3.9% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク)

</div>
