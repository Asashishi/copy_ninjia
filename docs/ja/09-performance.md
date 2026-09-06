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

**直近の全量ベンチマーク** · Bun 1.4.2 · 3 ラウンドの平均 · 2026-09-06T13:34:02Z · プロセス起動からローカル復元完了まで 487.7 ms · グループメッセージ 1 件を基本ディスパッチする 1.242 µs · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 1.20 ms / 741 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 5.77 ms / 147 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| カーネル | linux 6.8.0-138-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-09-06T13:34:02Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 385,931,405 |
| プロセス読み込み | 121.41 MiB |
| プロセス書き込み | 178.32 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 197.80 MiB |
| 読み込みシステムコール | 40,142 |
| 書き込みシステムコール | 85,101 |
| モックルート使用量 | 16.94 MiB |
| モックルートファイル数 | 163 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 136.8 ms | ±7.8% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 27.48 ms | ±42.0% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 850.3 µs | ±15.4% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.64 ms | ±16.4% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 8.54 ms | ±23.0% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 923.1 µs | ±6.4% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 291.9 ms | ±4.4% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 578.0 µs | ±9.8% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 487.7 ms | ±5.2% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 112.44 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 1.242 µs | 805,959 回/s | 84.21 MiB | 25.50 KiB | ±3.1% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 173.6 ns | 5,800,481 回/s | 85.18 MiB | 23.36 KiB | ±8.2% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 11.2 ns | 90,520,883 回/s | 72.31 MiB | 21.81 KiB | ±10.9% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 22.8 ns | 43,906,475 回/s | 72.92 MiB | 22.94 KiB | ±5.1% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.7 ns | 1,467,280,128 回/s | 71.91 MiB | 22.46 KiB | ±12.3% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 54.3 ns | 18,431,321 回/s | 74.16 MiB | 23.20 KiB | ±2.3% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.4 ns | 229,197,304 回/s | 71.87 MiB | 22.77 KiB | ±9.4% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 13.3 ns | 75,199,068 回/s | 72.94 MiB | 20.60 KiB | ±3.3% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 51.2 ns | 19,663,153 回/s | 73.83 MiB | 18.06 KiB | ±8.4% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 12.41 µs | 80,722 回/s | 95.38 MiB | 26.67 KiB | ±3.7% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 127.9 ns | 8,039,587 回/s | 79.63 MiB | 24.54 KiB | ±17.6% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 42.6 ns | 24,597,671 回/s | 80.79 MiB | 22.54 KiB | ±22.8% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 52.6 ns | 19,027,407 回/s | 74.14 MiB | 19.49 KiB | ±3.5% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 453.7 ns | 2,226,107 回/s | 115.77 MiB | 5.63 MiB | ±10.3% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 445.8 ns | 2,245,855 回/s | 128.96 MiB | 20.58 KiB | ±3.4% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.2 ns | 237,216,185 回/s | 73.29 MiB | 20.89 KiB | ±1.0% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 5.081 µs | 196,913 回/s | 82.73 MiB | 24.08 KiB | ±2.2% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 123.2 ns | 8,134,425 回/s | 114.93 MiB | 24.13 KiB | ±4.6% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 326.2 ns | 3,071,105 回/s | 97.99 MiB | 26.63 KiB | ±4.1% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 53.02 µs | 18,862 回/s | 96.31 MiB | 23.43 KiB | ±1.0% |
| 返信参照を抽出する<br><code>reply-reference</code> | 29.2 ns | 34,271,273 回/s | 82.58 MiB | 23.93 KiB | ±4.6% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 72.1 ns | 13,936,149 回/s | 85.45 MiB | 22.36 KiB | ±6.6% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 10.7 ns | 162,625,889 回/s | 78.88 MiB | 22.24 KiB | ±81.7% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 35.8 ns | 28,451,618 回/s | 80.64 MiB | 21.12 KiB | ±13.0% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 31.4 ns | 32,059,911 回/s | 73.13 MiB | 20.53 KiB | ±8.8% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 13.5 ns | 74,428,513 回/s | 77.03 MiB | 22.05 KiB | ±5.0% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 90.4 ns | 11,076,094 回/s | 72.57 MiB | 22.50 KiB | ±3.5% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 378 回/s | 2.65 ms | 1.98 ms | 5.26 ms | 23.12 ms | 378 レコード/s | 3.91 MiB | ±5.7% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 77 回/s | 13.00 ms | 13.38 ms | 22.83 ms | 34.56 ms | 9,847 レコード/s | 20.53 MiB | ±1.9% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 322 回/s | 3.11 ms | 2.48 ms | 6.82 ms | 17.97 ms | 322 レコード/s | 3.15 MiB | ±6.2% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 316 回/s | 3.16 ms | 2.52 ms | 6.15 ms | 25.04 ms | 316 レコード/s | 3.13 MiB | ±2.6% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 314 回/s | 3.20 ms | 2.54 ms | 7.06 ms | 20.08 ms | 314 レコード/s | 3.13 MiB | ±7.1% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 189 回/s | 5.31 ms | 4.53 ms | 10.45 ms | 22.50 ms | 189 レコード/s | 11.72 MiB | ±6.1% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 385 回/s | 2.60 ms | 2.07 ms | 4.89 ms | 20.09 ms | 385 レコード/s | 4.16 MiB | ±2.6% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 147 回/s | 6.82 ms | 5.77 ms | 14.06 ms | 26.59 ms | 147 レコード/s | 1.83 MiB | ±4.0% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 741 回/s | 1.34 ms | 1.20 ms | 2.02 ms | 3.58 ms | 741 レコード/s | 0 B | ±2.2% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 23,767,264 回/s | 337.7 ns | 0 B | 5.02 KiB | ±5.6% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 10,453 回/s | 12.27 ms | 61.90 MiB | 31.04 KiB | ±4.4% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 42,755 回/s | 187.1 µs | 4.86 MiB | 60.09 KiB | ±0.7% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 13,080 回/s | 612.8 µs | 2.70 MiB | 277.08 KiB | ±4.3% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 10,260 回/s | 12.48 ms | 67.73 MiB | 150.21 KiB | ±2.1% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 8,951 回/s | 14.30 ms | 9.00 MiB | 188.38 KiB | ±1.3% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 16.9 ns | 59,303,764 回/s | 80.04 MiB | 23.28 KiB | ±1.8% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 37.1 ns | 26,968,016 回/s | 74.52 MiB | 23.05 KiB | ±0.9% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 21.1 ns | 47,967,397 回/s | 81.32 MiB | 25.14 KiB | ±9.5% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 165.0 ms | 1.88 MiB | 5.04 KiB | ±7.5% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 30.55 ms | 0 B | -4.94 KiB | ±4.1% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク)

</div>
