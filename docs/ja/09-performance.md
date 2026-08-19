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

**直近の全量ベンチマーク** · Bun 1.3.14 · 3 ラウンドの平均 · 2026-08-19T06:31:16Z · `ready-total` 432.6 ms · `incoming-message-spine` 2,001.0 ns/op · `identity-policy-write` 5,302 ops/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.3.14 (`0d9b296af33f2b851fcbf4df3e9ec89751734ba4`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU | Intel Xeon E312xx (Sandy Bridge) × 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-08-19T06:31:16Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 385,240,415 |
| プロセス読み込み | 89.15 MiB |
| プロセス書き込み | 169.60 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 184.80 MiB |
| 読み込みシステムコール | 36,369 |
| 書き込みシステムコール | 79,016 |
| モックルート使用量 | 20.98 MiB |
| モックルートファイル数 | 140 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| `module-graph` | 154.6 ms | ±14.5% |
| `instance-lock` | 51.62 ms | ±61.8% |
| `orphan-cleanup` | 1.28 ms | ±24.7% |
| `state-load` | 2.23 ms | ±17.9% |
| `deployment-inputs` | 4.89 ms | ±13.2% |
| `disk-io-init` | 0.505 ms | ±12.4% |
| `persisted-load` | 164.6 ms | ±16.4% |
| `hydrate` | 1.03 ms | ±14.2% |
| `ready-total` | 432.6 ms | ±12.4% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 109.23 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 中央値レイテンシ | スループット | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| `incoming-message-spine` | 2,001.0 ns/op | 499,819 ops/s | 114.79 MiB | 28.65 KiB | ±1.2% |
| `sender-no-username` | 12.3 ns/op | 81,458,512 ops/s | 79.96 MiB | 22.24 KiB | ±0.8% |
| `sender-stable-username` | 30.2 ns/op | 33,528,998 ops/s | 80.00 MiB | 19.31 KiB | ±10.8% |
| `self-sent-empty` | 0.7 ns/op | 1,796,194,987 ops/s | 78.41 MiB | 21.29 KiB | ±43.0% |
| `chat-state-read` | 4.2 ns/op | 237,882,699 ops/s | 79.04 MiB | 20.93 KiB | ±1.2% |
| `chat-state-map-read` | 15.8 ns/op | 63,348,198 ops/s | 80.39 MiB | 20.26 KiB | ±2.1% |
| `ai-activity-window` | 54.0 ns/op | 18,506,791 ops/s | 82.50 MiB | 20.29 KiB | ±0.5% |
| `ai-activity-lru-miss` | 9,876.2 ns/op | 101,266 ops/s | 159.17 MiB | 24.17 KiB | ±1.1% |
| `identity-permission-read` | 100.6 ns/op | 9,970,895 ops/s | 90.04 MiB | 17.55 KiB | ±5.2% |
| `flood-window-hit` | 53.9 ns/op | 18,541,049 ops/s | 83.48 MiB | 18.78 KiB | ±0.5% |
| `flood-window-growth` | 513.9 ns/op | 1,950,673 ops/s | 138.36 MiB | 5.78 MiB | ±4.9% |
| `flood-window-steady` | 537.7 ns/op | 1,860,591 ops/s | 168.40 MiB | 31.47 MiB | ±2.2% |
| `ad-empty-metadata` | 4.5 ns/op | 221,725,284 ops/s | 80.40 MiB | 20.66 KiB | ±7.9% |
| `ad-wire-clone` | 5,467.7 ns/op | 182,961 ops/s | 146.36 MiB | -1.87 MiB | ±1.9% |
| `ad-capacity-reject` | 213.2 ns/op | 4,827,879 ops/s | 146.67 MiB | 24.11 KiB | ±17.5% |
| `buffered-message-build` | 715.2 ns/op | 1,399,214 ops/s | 118.96 MiB | 22.97 KiB | ±2.7% |
| `transcript-render` | 77,497.5 ns/op | 12,906 ops/s | 130.49 MiB | -1.87 MiB | ±1.5% |
| `reply-reference` | 24.6 ns/op | 40,700,033 ops/s | 108.88 MiB | 22.93 KiB | ±2.2% |
| `mention-facts` | 109.1 ns/op | 9,164,019 ops/s | 124.09 MiB | 20.60 KiB | ±1.5% |
| `mention-facts-plain` | 4.0 ns/op | 253,182,260 ops/s | 87.38 MiB | 20.44 KiB | ±4.4% |
| `gag-speak-counter` | 37.3 ns/op | 26,902,630 ops/s | 107.53 MiB | 20.69 KiB | ±5.1% |
| `luck-receipt-fast-path` | 39.0 ns/op | 25,711,681 ops/s | 105.78 MiB | 20.67 KiB | ±6.0% |
| `luck-tier-table` | 13.3 ns/op | 75,615,641 ops/s | 83.71 MiB | 18.97 KiB | ±7.9% |
| `redact-clean-log` | 91.2 ns/op | 11,019,628 ops/s | 81.62 MiB | 22.10 KiB | ±6.9% |

## チェーン · エンドツーエンドの永続化

> 各チェーンはメインスレッドの本番エントリから実際の Disk I/O Worker を駆動し、永続化の完了応答までを計測する。

| チェーン | スループット | p50 | p95 | p99 | 最大 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `join-log-append` | 337 ops/s | 2.13 ms | 8.63 ms | 14.08 ms | 25.59 ms | 3.91 MiB | ±5.3% |
| `identity-policy-write` | 5,302 ops/s | 26.08 ms | 43.09 ms | 60.36 ms | 93.42 ms | 20.53 MiB | ±2.3% |
| `chat-state-write` | 201 ops/s | 3.42 ms | 14.10 ms | 20.01 ms | 27.45 ms | 3.13 MiB | ±15.3% |
| `ai-memory-snapshot` | 28 ops/s | 35.76 ms | 82.62 ms | 105.0 ms | 111.7 ms | 7.03 MiB | ±18.3% |
| `diagnostic-log` | 257 ops/s | 2.72 ms | 12.21 ms | 17.93 ms | 34.16 ms | 4.16 MiB | ±15.4% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | スループット | バッチ遅延 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| `main-lru-read` | 20,684,355 ops/s | 0.000 ms | 0 B | 8.30 KiB | ±19.2% |
| `main-write-through-acked` | 5,597 ops/s | 22.87 ms | 61.91 MiB | -1.46 MiB | ±0.5% |
| `storage-read-hot-connection` | 26,872 ops/s | 0.298 ms | 4.83 MiB | -1.51 MiB | ±4.1% |
| `storage-read-cold-connection` | 9,983 ops/s | 0.807 ms | 2.67 MiB | 276.96 KiB | ±8.1% |
| `storage-write-hot-connection` | 5,789 ops/s | 22.28 ms | 67.68 MiB | -1.39 MiB | ±8.5% |
| `storage-write-cold-connection` | 5,729 ops/s | 22.35 ms | 8.91 MiB | 243.39 KiB | ±1.9% |

## 実装比較 · コンテナとアルゴリズム

> 同一処理の 2 実装の比較であり、選定時にのみ意味を持つ。本番で動くコードではない。

| 実装 | 中央値レイテンシ | スループット | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| `array-timestamp-window` | 23.4 ns/op | 43,009,728 ops/s | 82.48 MiB | 23.71 KiB | ±6.8% |
| `float64-timestamp-window` | 21.2 ns/op | 47,312,909 ops/s | 82.29 MiB | 26.24 KiB | ±6.6% |
| `array-timestamp-cold` | 152.6 ns/op | 6,634,511 ops/s | 93.33 MiB | 691.32 KiB | ±11.5% |
| `float64-timestamp-cold` | 174.2 ns/op | 5,944,271 ops/s | 95.13 MiB | 769.29 KiB | ±19.6% |
| `linked-timestamp-window` | 42.9 ns/op | 23,587,150 ops/s | 152.98 MiB | 22.76 KiB | ±11.0% |
| `linked-rolling-buffer` | 66.6 ns/op | 15,009,074 ops/s | 134.64 MiB | 20.97 KiB | ±1.2% |
| `bounded-rolling-buffer` | 30.5 ns/op | 32,786,499 ops/s | 108.06 MiB | 25.14 KiB | ±1.6% |

## 参加ログ · 25 万件の容量線

> `current` が現行実装、`baseline` は最適化前の全表コピーとソートを固定した計測用の参照。

| 比較対象 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| `snapshot:current` | 192.7 ms | 1.40 MiB | 4.92 KiB | ±3.6% |
| `snapshot:baseline` | 424.0 ms | 9.91 MiB | -384.47 KiB | ±1.5% |
| `capacity:current` | 50.32 ms | 0 B | -6.57 KiB | ±5.3% |
| `capacity:baseline` | 64.84 ms | 26.72 MiB | 702 B | ±10.0% |

> 再現方法：`bun run perf:full`（リリース時と明示的な指示時のみ実行）。データはすべて Git 管理外の `performance/` 配下に置かれ、設定は `config_example/` から読み込み、完了後に削除される。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](conntent-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク)

</div>
