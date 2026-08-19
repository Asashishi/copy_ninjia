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

**直近の全量ベンチマーク** · Bun 1.3.14 · 3 ラウンドの平均 · 2026-08-19T13:20:15Z · `ready-total` 349.0 ms · `incoming-message-spine` 1,893.5 ns/op · `identity-policy-write` 64 完全チェーン/s（永続化）

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.3.14 (`0d9b296af33f2b851fcbf4df3e9ec89751734ba4`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-08-19T13:20:15Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 367,030,605 |
| プロセス読み込み | 89.13 MiB |
| プロセス書き込み | 170.29 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 186.63 MiB |
| 読み込みシステムコール | 35,211 |
| 書き込みシステムコール | 80,515 |
| モックルート使用量 | 22.07 MiB |
| モックルートファイル数 | 152 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| `module-graph` | 130.7 ms | ±3.0% |
| `instance-lock` | 22.68 ms | ±2.8% |
| `orphan-cleanup` | 0.791 ms | ±18.0% |
| `state-load` | 2.02 ms | ±19.5% |
| `deployment-inputs` | 4.85 ms | ±18.9% |
| `disk-io-init` | 0.614 ms | ±33.2% |
| `persisted-load` | 144.3 ms | ±6.6% |
| `hydrate` | 0.846 ms | ±29.0% |
| `ready-total` | 349.0 ms | ±3.4% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 110.04 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 中央値レイテンシ | スループット | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| `incoming-message-spine` | 1,893.5 ns/op | 528,292 ops/s | 114.33 MiB | 28.79 KiB | ±1.8% |
| `sender-no-username` | 12.3 ns/op | 81,132,408 ops/s | 79.87 MiB | 20.41 KiB | ±0.6% |
| `sender-stable-username` | 27.0 ns/op | 37,039,262 ops/s | 80.70 MiB | 20.48 KiB | ±3.3% |
| `self-sent-empty` | 0.6 ns/op | 1,965,877,099 ops/s | 78.58 MiB | 21.19 KiB | ±28.6% |
| `chat-state-read` | 4.0 ns/op | 249,919,011 ops/s | 78.67 MiB | 22.41 KiB | ±2.8% |
| `chat-state-map-read` | 16.5 ns/op | 60,969,929 ops/s | 80.42 MiB | 21.45 KiB | ±7.2% |
| `ai-activity-window` | 57.1 ns/op | 17,529,288 ops/s | 82.79 MiB | 20.01 KiB | ±2.9% |
| `ai-activity-lru-miss` | 10,911.9 ns/op | 92,173 ops/s | 157.82 MiB | 24.13 KiB | ±7.7% |
| `identity-permission-read` | 95.8 ns/op | 10,444,193 ops/s | 90.43 MiB | 20.32 KiB | ±3.0% |
| `flood-window-hit` | 55.5 ns/op | 18,019,927 ops/s | 83.95 MiB | 21.39 KiB | ±2.4% |
| `flood-window-growth` | 521.1 ns/op | 1,927,093 ops/s | 139.85 MiB | 5.78 MiB | ±6.6% |
| `flood-window-steady` | 455.7 ns/op | 2,196,636 ops/s | 144.50 MiB | 20.81 KiB | ±3.1% |
| `ad-empty-metadata` | 4.8 ns/op | 211,088,445 ops/s | 80.71 MiB | 20.75 KiB | ±10.9% |
| `ad-wire-clone` | 5,603.6 ns/op | 179,035 ops/s | 146.06 MiB | -1.86 MiB | ±5.7% |
| `ad-capacity-reject` | 193.1 ns/op | 5,211,348 ops/s | 147.13 MiB | 23.85 KiB | ±7.9% |
| `buffered-message-build` | 707.5 ns/op | 1,413,860 ops/s | 121.86 MiB | 21.51 KiB | ±1.6% |
| `transcript-render` | 71,971.4 ns/op | 13,896 ops/s | 129.36 MiB | -1.87 MiB | ±1.2% |
| `reply-reference` | 23.4 ns/op | 42,862,473 ops/s | 109.53 MiB | 22.69 KiB | ±5.6% |
| `mention-facts` | 112.4 ns/op | 8,932,680 ops/s | 123.67 MiB | 19.39 KiB | ±6.5% |
| `mention-facts-plain` | 4.0 ns/op | 251,772,350 ops/s | 86.71 MiB | 22.14 KiB | ±2.2% |
| `gag-speak-counter` | 37.3 ns/op | 27,131,080 ops/s | 107.54 MiB | 20.32 KiB | ±11.0% |
| `luck-receipt-fast-path` | 36.6 ns/op | 27,390,926 ops/s | 105.83 MiB | 21.23 KiB | ±4.6% |
| `luck-tier-table` | 12.7 ns/op | 79,062,170 ops/s | 84.33 MiB | 21.01 KiB | ±3.2% |
| `redact-clean-log` | 83.1 ns/op | 12,049,184 ops/s | 81.50 MiB | 20.29 KiB | ±3.3% |

## チェーン · エンドツーエンドの永続化

> 各チェーンはメインスレッドの本番エントリから実際の Disk I/O Worker を駆動し、永続化の完了応答までを計測する。「完全チェーン/s」は永続化応答まで到達するコマンド数で、行をまたいで比較できる唯一のスループット。「レコード/s」はそこに載る業務レコード数で、バッチ処理のチェーンでは前者の倍数になる。`ad-detect-command` と `ai-reply-command` は 1 通のグループメッセージがコマンド全体を通る時間を計測する。モデル呼び出しと Telegram 送信はプロセス内の固定応答が返すため、計測値にネットワーク往復は一切含まれず、ネットワーク以外のすべての工程がプロセス内処理とディスクとして計測窓に入っている。`ai-reply-command` はさらに送信前の擬人的な間（基準 1.5 秒、1 文字あたり 55 ミリ秒、上限 7.5 秒）を差し引く。これはチャットごとの間合いで CPU を消費せず他チャットも止めないため、含めると`ai-memory-snapshot` のスループットはテール依存です。1 回ごとに約 46 KiB のスナップショットを全面書き換えし fsync を 2 回行うため、ページキャッシュに収まるかファイルシステムの書き戻し停止に当たるかで 1 回の値が桁違いに変わります。先行するセクションの書き戻し圧力を引き継ぐので、ラウンド平均は数倍ぶれることがあり（単独・無負荷では約 185 ops/s）、一方 p50 は安定しています。この行はまず変動列を見て、スループットではなく p50 で履歴と比較してください。処理能力ではなく意図的なリズムを報告することになる。差し引く量は 1 件ごとに実測しており推定ではない。このチェーンは「返信を送信した」時点までで永続化を含まない：本番の記憶スナップショットは30 秒タイマーでまとめて書き出す方式であり、返信 1 件ごとではない。その費用は`ai-memory-snapshot` の行が単独で示す。

| チェーン | 完全チェーン/s | レコード/s | p50 | p95 | p99 | 最大 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `join-log-append` | 372 ops/s | 372 records/s | 2.08 ms | 5.34 ms | 11.87 ms | 29.56 ms | 3.91 MiB | ±5.1% |
| `identity-policy-write` | 64 ops/s | 8,143 records/s | 16.62 ms | 26.22 ms | 31.08 ms | 41.70 ms | 20.53 MiB | ±2.2% |
| `chat-state-write` | 310 ops/s | 310 records/s | 2.72 ms | 5.50 ms | 12.12 ms | 14.69 ms | 3.13 MiB | ±2.0% |
| `ai-memory-snapshot` | 193 ops/s | 193 records/s | 4.61 ms | 8.32 ms | 14.47 ms | 23.94 ms | 7.03 MiB | ±1.7% |
| `diagnostic-log` | 373 ops/s | 373 records/s | 2.19 ms | 4.78 ms | 11.54 ms | 16.90 ms | 4.16 MiB | ±2.0% |
| `ad-detect-command` | 142 ops/s | 142 records/s | 6.26 ms | 12.18 ms | 20.37 ms | 21.95 ms | 1.83 MiB | ±0.8% |
| `ai-reply-command` | 616 ops/s | 616 records/s | 1.50 ms | 2.49 ms | 3.07 ms | 3.07 ms | 0 B | ±4.3% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | スループット | バッチ遅延 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| `main-lru-read` | 26,190,480 ops/s | 0.000 ms | 0 B | 7.82 KiB | ±7.3% |
| `main-write-through-acked` | 8,475 ops/s | 15.11 ms | 61.91 MiB | -1.46 MiB | ±1.2% |
| `storage-read-hot-connection` | 28,512 ops/s | 0.281 ms | 4.83 MiB | -1.51 MiB | ±4.7% |
| `storage-read-cold-connection` | 11,626 ops/s | 0.689 ms | 2.67 MiB | 268.13 KiB | ±2.5% |
| `storage-write-hot-connection` | 7,323 ops/s | 17.49 ms | 67.68 MiB | -1.39 MiB | ±2.4% |
| `storage-write-cold-connection` | 6,851 ops/s | 18.72 ms | 8.91 MiB | 249.53 KiB | ±4.4% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：スライディングウィンドウは `LinkedQueue` + `trimSlidingWindow`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 中央値レイテンシ | スループット | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| `linked-timestamp-window` | 43.0 ns/op | 24,003,425 ops/s | 154.72 MiB | 22.43 KiB | ±18.1% |
| `bounded-rolling-buffer` | 31.8 ns/op | 31,907,766 ops/s | 108.40 MiB | 26.79 KiB | ±12.8% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| `snapshot` | 171.3 ms | 1.39 MiB | 5.29 KiB | ±6.8% |
| `capacity` | 43.52 ms | 0 B | -5.67 KiB | ±4.7% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](conntent-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク)

</div>
