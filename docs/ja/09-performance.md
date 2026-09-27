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

**直近の全量ベンチマーク** · Bun 1.4.2 · 3 ラウンドの平均 · 2026-09-27T14:46:45Z · プロセス起動からローカル復元完了まで 392.8 ms · グループメッセージ 1 件を基本ディスパッチする 153.3 ns · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 822.6 µs / 1,144 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 1.90 ms / 487 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-09-27T14:46:45Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 392,931,429 |
| プロセス読み込み | 167.27 MiB |
| プロセス書き込み | 174.17 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 193.43 MiB |
| 読み込みシステムコール | 52,104 |
| 書き込みシステムコール | 86,120 |
| モックルート使用量 | 14.17 MiB |
| モックルートファイル数 | 104 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 160.1 ms | ±8.4% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 15.66 ms | ±21.2% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 691.6 µs | ±6.3% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.27 ms | ±11.1% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 4.56 ms | ±7.0% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 344.0 µs | ±8.9% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 197.8 ms | ±3.2% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 284.8 µs | ±3.2% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 392.8 ms | ±2.4% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 117.60 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 153.3 ns | 6,567,743 回/s | 91.65 MiB | 6.67 KiB | ±8.1% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 107.2 ns | 9,359,660 回/s | 90.89 MiB | 20.33 KiB | ±5.5% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 15.4 ns | 64,873,966 回/s | 77.46 MiB | 21.69 KiB | ±0.4% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 29.0 ns | 34,528,297 回/s | 77.74 MiB | 20.80 KiB | ±2.3% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 34.7 ns | 28,831,816 回/s | 79.34 MiB | 21.88 KiB | ±3.2% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.8 ns | 1,179,564,321 回/s | 76.19 MiB | 23.08 KiB | ±0.7% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 51.1 ns | 19,604,560 回/s | 79.05 MiB | 20.30 KiB | ±2.9% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.0 ns | 252,194,565 回/s | 76.89 MiB | 20.80 KiB | ±3.8% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 9.8 ns | 102,123,697 回/s | 76.92 MiB | 20.11 KiB | ±0.4% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 42.0 ns | 23,837,416 回/s | 79.33 MiB | 22.79 KiB | ±1.0% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 1.063 µs | 942,477 回/s | 102.10 MiB | 20.88 KiB | ±3.7% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 93.0 ns | 10,760,412 回/s | 85.48 MiB | 24.11 KiB | ±1.5% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 32.6 ns | 33,539,232 回/s | 85.82 MiB | 21.56 KiB | ±32.1% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 49.3 ns | 20,291,476 回/s | 79.29 MiB | 23.50 KiB | ±2.6% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 280.9 ns | 3,581,666 回/s | 118.48 MiB | 5.63 MiB | ±8.0% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 304.5 ns | 3,286,420 回/s | 155.15 MiB | 20.14 KiB | ±2.4% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.3 ns | 234,918,761 回/s | 77.91 MiB | 21.25 KiB | ±0.7% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 2.431 µs | 411,377 回/s | 89.14 MiB | 23.60 KiB | ±1.4% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 97.7 ns | 10,240,051 回/s | 123.18 MiB | 23.72 KiB | ±2.9% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 270.4 ns | 3,700,496 回/s | 89.06 MiB | 24.58 KiB | ±2.5% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 37.68 µs | 26,542 回/s | 101.73 MiB | 21.58 KiB | ±0.3% |
| 返信参照を抽出する<br><code>reply-reference</code> | 26.2 ns | 38,402,674 回/s | 91.02 MiB | 22.95 KiB | ±9.2% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 46.6 ns | 21,475,191 回/s | 97.01 MiB | 20.76 KiB | ±1.2% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 8.2 ns | 149,247,003 回/s | 77.46 MiB | 22.91 KiB | ±36.6% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 36.6 ns | 27,366,978 回/s | 86.18 MiB | 19.57 KiB | ±3.5% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 20.9 ns | 47,744,567 回/s | 77.15 MiB | 20.66 KiB | ±0.5% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 16.8 ns | 59,560,912 回/s | 79.43 MiB | 22.41 KiB | ±5.0% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 75.0 ns | 13,327,521 回/s | 78.46 MiB | 20.51 KiB | ±1.0% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。cron 音声の行も音声合成モデルと Telegram を固定応答（約 11 秒の WAV）に置き換え、Base64 デコード、WAV 解析、Opus エンコードと送信境界を含む。本番では合成は AI Worker 上で動くが、この行は同一プロセス内で両側をつなぎ、スレッド間の受け渡しは含まない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 897 回/s | 1.12 ms | 984.5 µs | 1.50 ms | 8.70 ms | 897 レコード/s | 3.91 MiB | ±3.4% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 147 回/s | 6.82 ms | 7.80 ms | 11.14 ms | 18.52 ms | 18,758 レコード/s | 21.42 MiB | ±0.5% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 693 回/s | 1.44 ms | 1.33 ms | 1.90 ms | 8.42 ms | 693 レコード/s | 3.15 MiB | ±1.7% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 680 回/s | 1.47 ms | 1.36 ms | 1.98 ms | 6.12 ms | 680 レコード/s | 3.13 MiB | ±3.8% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 692 回/s | 1.45 ms | 1.36 ms | 1.93 ms | 5.33 ms | 692 レコード/s | 3.13 MiB | ±2.3% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 369 回/s | 2.71 ms | 2.47 ms | 4.01 ms | 9.88 ms | 369 レコード/s | 5.55 MiB | ±2.2% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 860 回/s | 1.16 ms | 1.06 ms | 1.57 ms | 8.78 ms | 860 レコード/s | 4.16 MiB | ±1.3% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 487 回/s | 2.05 ms | 1.90 ms | 2.98 ms | 5.87 ms | 487 レコード/s | 1.20 MiB | ±2.4% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 1,144 回/s | 866.7 µs | 822.6 µs | 1.16 ms | 1.49 ms | 1,144 レコード/s | 0 B | ±1.4% |
| cron send_voice：音声 1 件を合成・エンコードして送信する（通信を除く）<br><code>cron-send-voice</code> | 5 回/s | 189.6 ms | 188.4 ms | 194.2 ms | 202.6 ms | 5 レコード/s | 0 B | ±1.8% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 28,559,631 回/s | 280.2 ns | 0 B | 5.75 KiB | ±1.5% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 20,320 回/s | 6.30 ms | 56.29 MiB | 47.11 KiB | ±0.3% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 77,333 回/s | 103.5 µs | 5.29 MiB | 76.16 KiB | ±1.6% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 17,245 回/s | 464.6 µs | 2.92 MiB | 295.86 KiB | ±3.7% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 18,297 回/s | 7.00 ms | 73.14 MiB | 188.41 KiB | ±1.7% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 14,437 回/s | 8.87 ms | 9.73 MiB | 222.27 KiB | ±2.4% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 16.6 ns | 60,724,326 回/s | 87.73 MiB | 23.01 KiB | ±7.7% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 35.6 ns | 28,117,502 回/s | 78.95 MiB | 23.81 KiB | ±1.4% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 19.1 ns | 52,707,016 回/s | 85.72 MiB | 24.05 KiB | ±7.8% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 120.3 ms | 1.74 MiB | 4.96 KiB | ±1.7% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 18.47 ms | 0 B | -3.60 KiB | ±1.5% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク) · [次のページ：10 よくある質問 →](10-faq.md)

</div>
