# 09 パフォーマンスベンチマーク

<p align="center">
  <a href="../cn/09-performance.md">简体中文</a> · <a href="../en/09-performance.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="conntent-table.md">📚 ドキュメントホーム</a> · <a href="08-commands.md">← 前のページ：08 コマンドと挙動リファレンス</a> · <b>次のページ：なし →</b>
</p>

---

本ページの計測値は `bun run perf:full -- --write-doc` が生成し、リリースごとに再実行して一括で上書きします。
下の 2 つのマーカーに挟まれた内容は手で編集せず、3 言語のうち 1 つだけを更新することもしないでください。

ベンチマークはリリース時と明示的な指示があったときにのみ実行し、`bun run check` には含めません。
ホットパスの GC/RSS/JIT ハードゲートは `bun run perf:hot-path-gate` が担当します。
[05 開発フローと品質ゲート](05-dev-workflow.md) を参照してください。

<!-- performance-benchmark:start -->

**直近の全量ベンチマーク** · Bun 1.3.14 · 3 ラウンドの平均 · 2026-08-20T06:08:06Z · プロセス起動からローカル復元完了まで 398.4 ms · グループメッセージ 1 件を基本ディスパッチする 1.964 µs · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 1.21 ms / 723 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 8.46 ms / 100 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.3.14 (`0d9b296af33f2b851fcbf4df3e9ec89751734ba4`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-08-20T06:08:06Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 367,030,605 |
| プロセス読み込み | 89.04 MiB |
| プロセス書き込み | 170.29 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 186.63 MiB |
| 読み込みシステムコール | 36,024 |
| 書き込みシステムコール | 80,508 |
| モックルート使用量 | 22.07 MiB |
| モックルートファイル数 | 152 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 147.2 ms | ±7.0% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 35.39 ms | ±32.4% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 1.09 ms | ±7.4% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 2.32 ms | ±24.2% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 5.26 ms | ±22.9% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 540.6 µs | ±16.5% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 160.3 ms | ±10.5% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 1.02 ms | ±25.4% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 398.4 ms | ±5.2% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 111.75 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 1.964 µs | 509,241 回/s | 133.36 MiB | 27.67 KiB | ±0.3% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 14.3 ns | 70,022,581 回/s | 98.86 MiB | 21.43 KiB | ±3.3% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 27.5 ns | 36,525,409 回/s | 99.73 MiB | 20.46 KiB | ±7.1% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.7 ns | 1,526,206,288 回/s | 97.63 MiB | 22.61 KiB | ±4.3% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.5 ns | 223,039,628 回/s | 97.71 MiB | 20.78 KiB | ±10.3% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 16.9 ns | 59,192,754 回/s | 99.35 MiB | 20.13 KiB | ±4.8% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 60.7 ns | 16,818,034 回/s | 101.26 MiB | 21.10 KiB | ±15.0% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 10.77 µs | 93,018 回/s | 174.94 MiB | 22.58 KiB | ±4.0% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 97.3 ns | 10,288,440 回/s | 109.07 MiB | 17.46 KiB | ±4.0% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 59.8 ns | 16,971,664 回/s | 102.67 MiB | 18.97 KiB | ±12.3% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 513.9 ns | 1,946,601 回/s | 157.44 MiB | 5.78 MiB | ±1.8% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 517.2 ns | 1,937,448 回/s | 167.00 MiB | 19.87 KiB | ±4.4% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.6 ns | 219,582,112 回/s | 100.17 MiB | 21.30 KiB | ±5.4% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 5.354 µs | 186,855 回/s | 165.19 MiB | -1.86 MiB | ±1.9% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 186.5 ns | 5,431,470 回/s | 166.15 MiB | 22.49 KiB | ±10.8% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 715.8 ns | 1,397,132 回/s | 139.95 MiB | 22.30 KiB | ±0.8% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 78.22 µs | 12,785 回/s | 130.86 MiB | -1.85 MiB | ±0.2% |
| 返信参照を抽出する<br><code>reply-reference</code> | 25.1 ns | 40,134,861 回/s | 128.92 MiB | 23.42 KiB | ±9.5% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 127.3 ns | 8,048,655 回/s | 143.31 MiB | 20.97 KiB | ±15.3% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 4.3 ns | 235,171,760 回/s | 104.67 MiB | 20.82 KiB | ±8.0% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 37.6 ns | 26,900,341 回/s | 126.81 MiB | 20.96 KiB | ±10.9% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 35.1 ns | 28,493,506 回/s | 124.45 MiB | 21.79 KiB | ±3.1% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 13.0 ns | 77,174,498 回/s | 103.62 MiB | 19.06 KiB | ±3.9% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 85.2 ns | 11,750,027 回/s | 100.24 MiB | 22.51 KiB | ±2.4% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 5 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 305 回/s | 3.28 ms | 2.37 ms | 9.37 ms | 28.23 ms | 305 レコード/s | 3.91 MiB | ±5.5% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 52 回/s | 19.36 ms | 19.18 ms | 36.23 ms | 60.28 ms | 6,670 レコード/s | 20.53 MiB | ±9.3% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 210 回/s | 4.75 ms | 3.64 ms | 12.77 ms | 25.05 ms | 210 レコード/s | 3.13 MiB | ±0.2% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 143 回/s | 7.05 ms | 5.23 ms | 15.53 ms | 45.94 ms | 143 レコード/s | 7.03 MiB | ±9.1% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 281 回/s | 3.55 ms | 2.63 ms | 10.56 ms | 25.60 ms | 281 レコード/s | 4.16 MiB | ±1.7% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 100 回/s | 9.97 ms | 8.46 ms | 20.70 ms | 30.63 ms | 100 レコード/s | 1.83 MiB | ±2.4% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 723 回/s | 1.37 ms | 1.21 ms | 2.23 ms | 4.27 ms | 723 レコード/s | 0 B | ±1.4% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 21,663,984 回/s | 371.8 ns | 0 B | 5.12 KiB | ±8.5% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 7,649 回/s | 16.73 ms | 61.91 MiB | -1.46 MiB | ±0.6% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 27,304 回/s | 293.3 µs | 4.83 MiB | -1.52 MiB | ±3.0% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 10,711 回/s | 750.3 µs | 2.67 MiB | 273.21 KiB | ±6.7% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 6,758 回/s | 18.94 ms | 67.68 MiB | -1.40 MiB | ±0.3% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 6,092 回/s | 21.03 ms | 8.91 MiB | 242.61 KiB | ±3.2% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：スライディングウィンドウは `LinkedQueue` + `trimSlidingWindow`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 時刻スライディングウィンドウの追加と期限切れ削除<br><code>linked-timestamp-window</code> | 50.5 ns | 21,023,254 回/s | 172.62 MiB | 23.17 KiB | ±26.1% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 30.0 ns | 33,322,481 回/s | 127.10 MiB | 25.41 KiB | ±1.5% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 188.3 ms | 1.40 MiB | 3.50 KiB | ±5.0% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 52.53 ms | 0 B | -8.69 KiB | ±6.4% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](conntent-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク)

</div>
