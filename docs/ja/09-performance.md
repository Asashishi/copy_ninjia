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

**直近の全量ベンチマーク** · Bun 1.3.14 · 3 ラウンドの平均 · 2026-08-19T08:06:09Z · `ready-total` 392.5 ms · `incoming-message-spine` 1,983.8 ns/op · `identity-policy-write` 5,410 ops/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.3.14 (`0d9b296af33f2b851fcbf4df3e9ec89751734ba4`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-08-19T08:06:09Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 367,030,415 |
| プロセス読み込み | 89.15 MiB |
| プロセス書き込み | 169.60 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 184.80 MiB |
| 読み込みシステムコール | 36,309 |
| 書き込みシステムコール | 79,005 |
| モックルート使用量 | 20.99 MiB |
| モックルートファイル数 | 140 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| `module-graph` | 143.2 ms | ±1.9% |
| `instance-lock` | 30.87 ms | ±19.3% |
| `orphan-cleanup` | 0.884 ms | ±11.1% |
| `state-load` | 1.91 ms | ±17.1% |
| `deployment-inputs` | 4.42 ms | ±13.7% |
| `disk-io-init` | 0.525 ms | ±13.2% |
| `persisted-load` | 163.3 ms | ±7.2% |
| `hydrate` | 0.940 ms | ±18.1% |
| `ready-total` | 392.5 ms | ±3.9% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 109.41 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 中央値レイテンシ | スループット | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| `incoming-message-spine` | 1,983.8 ns/op | 504,162 ops/s | 114.67 MiB | 28.31 KiB | ±1.2% |
| `sender-no-username` | 13.7 ns/op | 73,582,912 ops/s | 80.41 MiB | 20.70 KiB | ±7.4% |
| `sender-stable-username` | 32.4 ns/op | 31,224,265 ops/s | 80.17 MiB | 21.15 KiB | ±10.8% |
| `self-sent-empty` | 0.7 ns/op | 1,392,133,368 ops/s | 78.04 MiB | 22.05 KiB | ±11.8% |
| `chat-state-read` | 4.4 ns/op | 228,497,199 ops/s | 79.08 MiB | 20.77 KiB | ±5.4% |
| `chat-state-map-read` | 16.3 ns/op | 61,533,830 ops/s | 80.05 MiB | 21.01 KiB | ±2.9% |
| `ai-activity-window` | 60.1 ns/op | 16,725,942 ops/s | 82.74 MiB | 20.44 KiB | ±7.9% |
| `ai-activity-lru-miss` | 10,438.3 ns/op | 96,198 ops/s | 158.12 MiB | 23.89 KiB | ±6.4% |
| `identity-permission-read` | 121.7 ns/op | 8,253,940 ops/s | 89.16 MiB | 20.00 KiB | ±6.7% |
| `flood-window-hit` | 54.0 ns/op | 18,594,936 ops/s | 83.87 MiB | 19.51 KiB | ±6.6% |
| `flood-window-growth` | 497.3 ns/op | 2,012,937 ops/s | 137.50 MiB | 5.78 MiB | ±3.1% |
| `flood-window-steady` | 563.2 ns/op | 1,779,972 ops/s | 143.27 MiB | 21.27 KiB | ±4.9% |
| `ad-empty-metadata` | 5.8 ns/op | 183,154,585 ops/s | 80.83 MiB | 20.88 KiB | ±21.7% |
| `ad-wire-clone` | 5,389.3 ns/op | 185,852 ops/s | 145.92 MiB | -1.86 MiB | ±4.0% |
| `ad-capacity-reject` | 214.3 ns/op | 4,718,897 ops/s | 146.18 MiB | 23.05 KiB | ±10.5% |
| `buffered-message-build` | 768.7 ns/op | 1,301,082 ops/s | 119.70 MiB | 23.25 KiB | ±1.0% |
| `transcript-render` | 74,319.5 ns/op | 13,458 ops/s | 126.58 MiB | -1.86 MiB | ±1.4% |
| `reply-reference` | 24.8 ns/op | 40,888,955 ops/s | 109.07 MiB | 22.91 KiB | ±12.0% |
| `mention-facts` | 114.8 ns/op | 8,726,816 ops/s | 124.02 MiB | 20.62 KiB | ±4.7% |
| `mention-facts-plain` | 4.0 ns/op | 247,441,531 ops/s | 86.58 MiB | 20.74 KiB | ±3.6% |
| `gag-speak-counter` | 38.7 ns/op | 25,878,997 ops/s | 107.37 MiB | 20.56 KiB | ±3.3% |
| `luck-receipt-fast-path` | 36.0 ns/op | 27,860,245 ops/s | 106.13 MiB | 20.89 KiB | ±5.6% |
| `luck-tier-table` | 13.8 ns/op | 72,839,280 ops/s | 84.58 MiB | 20.08 KiB | ±6.4% |
| `redact-clean-log` | 85.1 ns/op | 11,756,600 ops/s | 81.61 MiB | 21.41 KiB | ±1.7% |

## チェーン · エンドツーエンドの永続化

> 各チェーンはメインスレッドの本番エントリから実際の Disk I/O Worker を駆動し、永続化の完了応答までを計測する。

| チェーン | スループット | p50 | p95 | p99 | 最大 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `join-log-append` | 313 ops/s | 2.24 ms | 10.14 ms | 15.31 ms | 29.77 ms | 3.91 MiB | ±5.5% |
| `identity-policy-write` | 5,410 ops/s | 25.76 ms | 41.66 ms | 49.77 ms | 60.26 ms | 20.53 MiB | ±1.8% |
| `chat-state-write` | 237 ops/s | 3.21 ms | 11.68 ms | 15.60 ms | 27.04 ms | 3.13 MiB | ±4.5% |
| `ai-memory-snapshot` | 33 ops/s | 31.55 ms | 66.98 ms | 94.65 ms | 108.7 ms | 7.03 MiB | ±8.2% |
| `diagnostic-log` | 298 ops/s | 2.38 ms | 10.96 ms | 14.82 ms | 31.86 ms | 4.16 MiB | ±1.8% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | スループット | バッチ遅延 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| `main-lru-read` | 24,380,841 ops/s | 0.000 ms | 0 B | 5.27 KiB | ±2.5% |
| `main-write-through-acked` | 5,747 ops/s | 22.27 ms | 61.91 MiB | -1.46 MiB | ±0.6% |
| `storage-read-hot-connection` | 27,450 ops/s | 0.292 ms | 4.83 MiB | -1.51 MiB | ±2.1% |
| `storage-read-cold-connection` | 10,890 ops/s | 0.736 ms | 2.67 MiB | 260.13 KiB | ±3.6% |
| `storage-write-hot-connection` | 6,245 ops/s | 20.50 ms | 67.68 MiB | -1.39 MiB | ±1.1% |
| `storage-write-cold-connection` | 5,617 ops/s | 22.87 ms | 8.91 MiB | 242.52 KiB | ±6.1% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：スライディングウィンドウは `LinkedQueue` + `trimSlidingWindow`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 中央値レイテンシ | スループット | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| `linked-timestamp-window` | 35.0 ns/op | 28,769,422 ops/s | 155.39 MiB | 21.64 KiB | ±7.9% |
| `bounded-rolling-buffer` | 33.1 ns/op | 30,529,867 ops/s | 107.60 MiB | 24.53 KiB | ±9.9% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| `snapshot` | 183.8 ms | 1.39 MiB | 4.92 KiB | ±1.9% |
| `capacity` | 44.18 ms | 0 B | -9.71 KiB | ±4.6% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](conntent-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク)

</div>
