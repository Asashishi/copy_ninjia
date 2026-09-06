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

**直近の全量ベンチマーク** · Bun 1.4.2 · 3 ラウンドの平均 · 2026-09-06T07:31:56Z · プロセス起動からローカル復元完了まで 477.0 ms · グループメッセージ 1 件を基本ディスパッチする 1.379 µs · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 1.24 ms / 745 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 5.70 ms / 152 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| カーネル | linux 6.8.0-138-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-09-06T07:31:56Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 385,931,405 |
| プロセス読み込み | 121.27 MiB |
| プロセス書き込み | 178.32 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 197.80 MiB |
| 読み込みシステムコール | 39,953 |
| 書き込みシステムコール | 85,158 |
| モックルート使用量 | 16.24 MiB |
| モックルートファイル数 | 163 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 136.4 ms | ±5.9% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 16.56 ms | ±1.2% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 763.6 µs | ±11.3% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.54 ms | ±10.4% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 6.73 ms | ±12.9% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 853.8 µs | ±4.4% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 287.7 ms | ±5.3% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 575.3 µs | ±7.7% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 477.0 ms | ±4.8% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 111.30 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 1.379 µs | 733,269 回/s | 82.04 MiB | 26.05 KiB | ±10.5% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 168.3 ns | 5,955,016 回/s | 86.49 MiB | 23.20 KiB | ±4.8% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 11.3 ns | 89,046,511 回/s | 72.54 MiB | 21.90 KiB | ±7.7% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 24.3 ns | 41,100,851 回/s | 72.79 MiB | 21.63 KiB | ±1.6% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.7 ns | 1,482,498,941 回/s | 71.46 MiB | 23.35 KiB | ±5.6% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 56.1 ns | 17,859,965 回/s | 74.42 MiB | 23.19 KiB | ±3.4% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.2 ns | 238,264,288 回/s | 72.59 MiB | 23.38 KiB | ±7.9% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 12.6 ns | 79,589,945 回/s | 73.47 MiB | 22.91 KiB | ±0.1% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 52.6 ns | 19,337,169 回/s | 74.27 MiB | 19.93 KiB | ±13.4% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 12.85 µs | 77,979 回/s | 96.10 MiB | 24.52 KiB | ±4.2% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 110.8 ns | 9,025,855 回/s | 79.81 MiB | 22.56 KiB | ±2.0% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 35.2 ns | 28,928,915 回/s | 80.83 MiB | 23.80 KiB | ±13.5% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 53.0 ns | 18,885,108 回/s | 74.76 MiB | 18.60 KiB | ±1.3% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 394.8 ns | 2,544,270 回/s | 119.02 MiB | 5.63 MiB | ±6.5% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 445.1 ns | 2,254,845 回/s | 133.70 MiB | 19.38 KiB | ±6.0% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.8 ns | 207,510,272 回/s | 73.22 MiB | 21.06 KiB | ±7.2% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 5.199 µs | 192,566 回/s | 82.33 MiB | 24.30 KiB | ±3.3% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 132.8 ns | 7,584,970 回/s | 114.39 MiB | 24.49 KiB | ±8.5% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 315.3 ns | 3,173,010 回/s | 100.06 MiB | 27.10 KiB | ±2.3% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 54.83 µs | 18,240 回/s | 95.55 MiB | 21.32 KiB | ±1.4% |
| 返信参照を抽出する<br><code>reply-reference</code> | 24.5 ns | 40,902,456 回/s | 81.88 MiB | 23.37 KiB | ±4.7% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 74.5 ns | 13,428,641 回/s | 84.17 MiB | 22.83 KiB | ±3.0% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 8.7 ns | 174,344,475 回/s | 78.35 MiB | 21.57 KiB | ±71.8% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 33.3 ns | 30,363,652 回/s | 80.71 MiB | 20.46 KiB | ±9.8% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 26.4 ns | 38,669,615 回/s | 72.68 MiB | 21.64 KiB | ±15.2% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 12.1 ns | 82,577,468 回/s | 75.68 MiB | 21.69 KiB | ±3.4% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 85.3 ns | 11,766,556 回/s | 74.23 MiB | 23.29 KiB | ±5.7% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 391 回/s | 2.56 ms | 2.00 ms | 5.22 ms | 24.02 ms | 391 レコード/s | 3.91 MiB | ±5.2% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 75 回/s | 13.26 ms | 13.44 ms | 23.84 ms | 78.64 ms | 9,655 レコード/s | 20.53 MiB | ±2.1% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 309 回/s | 3.25 ms | 2.59 ms | 7.58 ms | 19.04 ms | 309 レコード/s | 3.15 MiB | ±5.7% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 327 回/s | 3.05 ms | 2.53 ms | 5.54 ms | 24.00 ms | 327 レコード/s | 3.13 MiB | ±2.8% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 308 回/s | 3.26 ms | 2.66 ms | 6.51 ms | 18.21 ms | 308 レコード/s | 3.13 MiB | ±5.9% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 176 回/s | 5.72 ms | 4.73 ms | 12.13 ms | 25.90 ms | 176 レコード/s | 11.72 MiB | ±7.7% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 390 回/s | 2.56 ms | 2.08 ms | 4.38 ms | 24.18 ms | 390 レコード/s | 4.16 MiB | ±1.9% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 152 回/s | 6.59 ms | 5.70 ms | 13.37 ms | 22.94 ms | 152 レコード/s | 1.83 MiB | ±2.7% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 745 回/s | 1.33 ms | 1.24 ms | 2.29 ms | 2.65 ms | 745 レコード/s | 0 B | ±3.8% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 26,697,095 回/s | 300.1 ns | 0 B | 7.26 KiB | ±3.8% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 10,735 回/s | 11.92 ms | 61.90 MiB | 30.60 KiB | ±0.5% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 42,646 回/s | 187.6 µs | 4.86 MiB | 58.21 KiB | ±0.7% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 13,005 回/s | 615.5 µs | 2.70 MiB | 274.92 KiB | ±2.3% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 10,331 回/s | 12.39 ms | 67.73 MiB | 149.87 KiB | ±1.9% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 8,851 回/s | 14.47 ms | 9.00 MiB | 195.02 KiB | ±2.5% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 16.9 ns | 59,201,592 回/s | 81.54 MiB | 23.39 KiB | ±2.1% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 40.8 ns | 24,749,007 回/s | 74.41 MiB | 21.92 KiB | ±10.4% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 18.0 ns | 55,787,387 回/s | 81.13 MiB | 24.66 KiB | ±5.8% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 151.6 ms | 2.00 MiB | 5.00 KiB | ±3.6% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 28.14 ms | 0 B | -4.94 KiB | ±2.0% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク)

</div>
