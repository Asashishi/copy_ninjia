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

**直近の全量ベンチマーク** · Bun 1.4.2 · 3 ラウンドの平均 · 2026-09-25T11:22:07Z · プロセス起動からローカル復元完了まで 324.0 ms · グループメッセージ 1 件を基本ディスパッチする 155.4 ns · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 814.0 µs / 1,148 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 2.89 ms / 322 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-09-25T11:22:07Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 392,931,429 |
| プロセス読み込み | 164.59 MiB |
| プロセス書き込み | 173.94 MiB |
| ブロックデバイス読み込み | 1.33 KiB |
| ブロックデバイス書き込み | 193.70 MiB |
| 読み込みシステムコール | 52,077 |
| 書き込みシステムコール | 86,199 |
| モックルート使用量 | 15.47 MiB |
| モックルートファイル数 | 117 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 107.3 ms | ±3.9% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 13.11 ms | ±12.0% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 507.5 µs | ±2.6% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.37 ms | ±8.8% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 3.77 ms | ±4.7% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 706.3 µs | ±6.2% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 182.9 ms | ±1.3% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 1.41 ms | ±55.7% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 324.0 ms | ±0.2% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 112.22 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 155.4 ns | 6,440,719 回/s | 91.12 MiB | 7.94 KiB | ±2.6% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 91.9 ns | 10,885,571 回/s | 93.11 MiB | 20.92 KiB | ±1.0% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 15.8 ns | 63,469,748 回/s | 77.68 MiB | 21.72 KiB | ±1.8% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 26.2 ns | 43,004,050 回/s | 77.79 MiB | 21.10 KiB | ±30.7% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 34.1 ns | 29,336,443 回/s | 79.17 MiB | 21.43 KiB | ±0.2% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.9 ns | 1,171,299,943 回/s | 76.62 MiB | 22.16 KiB | ±0.3% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 48.9 ns | 20,514,079 回/s | 78.57 MiB | 20.26 KiB | ±4.9% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 3.9 ns | 257,665,705 回/s | 76.90 MiB | 21.16 KiB | ±3.9% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 9.8 ns | 102,412,714 回/s | 77.94 MiB | 19.27 KiB | ±0.7% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 40.8 ns | 24,485,161 回/s | 78.59 MiB | 19.89 KiB | ±0.8% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 8.595 µs | 116,869 回/s | 101.02 MiB | 20.65 KiB | ±6.9% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 92.5 ns | 10,810,178 回/s | 84.67 MiB | 23.88 KiB | ±0.3% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 23.7 ns | 42,271,344 回/s | 86.58 MiB | 22.22 KiB | ±1.1% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 50.5 ns | 19,814,250 回/s | 79.49 MiB | 22.39 KiB | ±1.2% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 259.0 ns | 3,866,667 回/s | 124.25 MiB | 5.63 MiB | ±4.1% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 313.8 ns | 3,186,562 回/s | 138.71 MiB | 18.42 KiB | ±0.3% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.4 ns | 228,515,196 回/s | 77.32 MiB | 20.02 KiB | ±5.0% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 4.415 µs | 226,527 回/s | 88.02 MiB | 23.41 KiB | ±0.7% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 97.2 ns | 10,299,139 回/s | 122.58 MiB | 24.70 KiB | ±2.7% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 279.5 ns | 3,577,678 回/s | 89.61 MiB | 24.80 KiB | ±0.9% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 37.04 µs | 27,003 回/s | 100.18 MiB | 21.97 KiB | ±1.1% |
| 返信参照を抽出する<br><code>reply-reference</code> | 28.4 ns | 35,431,581 回/s | 91.26 MiB | 23.69 KiB | ±7.4% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 46.6 ns | 21,446,550 回/s | 93.08 MiB | 21.99 KiB | ±1.2% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 7.9 ns | 151,801,355 回/s | 77.54 MiB | 22.04 KiB | ±35.7% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 35.3 ns | 28,321,246 回/s | 86.14 MiB | 18.48 KiB | ±0.8% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 20.4 ns | 48,928,062 回/s | 76.91 MiB | 21.62 KiB | ±0.5% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 15.7 ns | 63,817,799 回/s | 79.32 MiB | 21.68 KiB | ±2.8% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 71.8 ns | 13,987,453 回/s | 78.37 MiB | 21.85 KiB | ±6.1% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。cron 音声の行も音声合成モデルと Telegram を固定応答（約 11 秒の WAV）に置き換え、Base64 デコード、WAV 解析、Opus エンコードと送信境界を含む。本番では合成は AI Worker 上で動くが、この行は同一プロセス内で両側をつなぎ、スレッド間の受け渡しは含まない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 885 回/s | 1.13 ms | 1.01 ms | 1.57 ms | 8.74 ms | 885 レコード/s | 3.91 MiB | ±5.1% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 145 回/s | 6.92 ms | 7.74 ms | 11.37 ms | 19.15 ms | 18,497 レコード/s | 21.42 MiB | ±1.1% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 585 回/s | 1.71 ms | 1.50 ms | 2.93 ms | 8.97 ms | 585 レコード/s | 3.15 MiB | ±6.0% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 619 回/s | 1.62 ms | 1.47 ms | 2.40 ms | 6.85 ms | 619 レコード/s | 3.13 MiB | ±6.2% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 650 回/s | 1.54 ms | 1.42 ms | 2.00 ms | 9.37 ms | 650 レコード/s | 3.13 MiB | ±2.3% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 360 回/s | 2.78 ms | 2.58 ms | 3.59 ms | 10.13 ms | 360 レコード/s | 5.55 MiB | ±0.8% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 829 回/s | 1.21 ms | 1.09 ms | 1.62 ms | 9.69 ms | 829 レコード/s | 4.16 MiB | ±0.9% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 322 回/s | 3.11 ms | 2.89 ms | 4.32 ms | 7.49 ms | 322 レコード/s | 1.83 MiB | ±1.2% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 1,148 回/s | 863.7 µs | 814.0 µs | 1.16 ms | 1.57 ms | 1,148 レコード/s | 0 B | ±1.1% |
| cron send_voice：音声 1 件を合成・エンコードして送信する（通信を除く）<br><code>cron-send-voice</code> | 5 回/s | 185.0 ms | 184.4 ms | 189.8 ms | 195.6 ms | 5 レコード/s | 0 B | ±0.2% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 29,684,622 回/s | 269.5 ns | 0 B | 6.76 KiB | ±1.0% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 20,172 回/s | 6.35 ms | 56.29 MiB | 44.94 KiB | ±1.7% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 75,114 回/s | 106.5 µs | 5.29 MiB | 72.96 KiB | ±1.1% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 17,103 回/s | 468.5 µs | 2.92 MiB | 294.27 KiB | ±4.1% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 17,842 回/s | 7.18 ms | 73.14 MiB | 163.28 KiB | ±1.5% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 14,865 回/s | 8.61 ms | 9.73 MiB | 210.90 KiB | ±1.7% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 16.8 ns | 60,047,595 回/s | 88.80 MiB | 23.13 KiB | ±8.6% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 37.0 ns | 27,050,257 回/s | 78.97 MiB | 23.84 KiB | ±2.2% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 17.1 ns | 58,738,068 回/s | 85.73 MiB | 25.38 KiB | ±5.4% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 117.4 ms | 1.68 MiB | 4.89 KiB | ±2.2% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 14.49 ms | 0 B | -4.94 KiB | ±6.5% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク) · [次のページ：10 よくある質問 →](10-faq.md)

</div>
