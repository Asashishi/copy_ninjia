/**
 * 基准区块的三语文案表。
 *
 * 被测对象的 id（场景名、链路名、操作名）**不翻译**：它们是代码里的标识符，
 * 在 `scripts/perf/` 的参数、报告 JSON 和这三份 README 里必须是同一个词，
 * 翻译过去就没法照着 README 去重跑那一项了。翻译只覆盖标题、列名和说明。
 */

import type { SectionId } from "./types";

/** README 的三种语言；对应根 README.md 与 docs/{en,ja}/README.md。 */
export type Language = "zh" | "en" | "ja";

/** 一份语言的完整文案。 */
export interface BenchmarkCopy {
  readonly summaryPrefix: string;
  /** 摘要行里的轮数说明；`{n}` 由渲染层替换成实际轮数。 */
  readonly summaryRounds: string;
  readonly environmentTitle: string;
  readonly environmentLabels: Readonly<Record<
    "runtime" | "kernel" | "cpu" | "memory" | "rounds" | "dataRoot" | "generatedAt",
    string
  >>;
  readonly totalsTitle: string;
  readonly totalsNote: string;
  readonly totalsLabels: Readonly<Record<
    | "measuredOperations"
    | "rcharBytes"
    | "wcharBytes"
    | "readBytes"
    | "writeBytes"
    | "readSyscalls"
    | "writeSyscalls"
    | "mockRootBytes"
    | "mockRootFiles",
    string
  >>;
  readonly sectionTitles: Readonly<Record<SectionId, string>>;
  readonly sectionNotes: Readonly<Record<SectionId, string>>;
  readonly sectionSubjects: Readonly<Record<SectionId, string>>;
  readonly metricLabels: Readonly<Record<string, string>>;
  readonly variationColumn: string;
  readonly coldStartCaption: string;
  readonly metricColumn: string;
  readonly valueColumn: string;
  readonly footer: string;
}

const ZH: BenchmarkCopy = {
  summaryPrefix: "最近一次全量基准",
  summaryRounds: "{n} 轮取平均",
  environmentTitle: "运行环境",
  environmentLabels: {
    runtime: "运行时",
    kernel: "内核",
    cpu: "CPU",
    memory: "内存",
    rounds: "轮数",
    dataRoot: "mock 数据根",
    generatedAt: "出数时间",
  },
  totalsTitle: "总吞吐与总读写（每轮）",
  totalsNote:
    "读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；" +
    "热路径与容量线子进程是纯进程内计算，不产生文件读写。" +
    "「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。",
  totalsLabels: {
    measuredOperations: "被测操作数",
    rcharBytes: "进程读入",
    wcharBytes: "进程写出",
    readBytes: "块设备读",
    writeBytes: "块设备写",
    readSyscalls: "读系统调用",
    writeSyscalls: "写系统调用",
    mockRootBytes: "mock 根落盘",
    mockRootFiles: "mock 根文件数",
  },
  sectionTitles: {
    "cold-start": "冷路径 · 启动恢复",
    "hot-path": "热路径 · 生产函数",
    chain: "链路 · 端到端 durable 耗时",
    storage: "存储 · SQLite 与主线程缓存",
    "hot-path-comparison": "实现对照 · 容器与算法选型",
    "join-log-capacity": "入群日志 · 25 万容量线",
  },
  sectionNotes: {
    "cold-start":
      "满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；" +
      "不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。",
    "hot-path":
      "每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。",
    chain:
      "每条链路都由主线程生产入口驱动真实 Disk I/O Worker，计时到落盘 durable 回执为止。",
    storage:
      "复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。",
    "hot-path-comparison":
      "同一件事的两种实现对照，只在选型时有意义；这些不是线上跑的代码。",
    "join-log-capacity":
      "`current` 是当前实现，`baseline` 固化优化前的整表复制与排序，只作测量参照。",
  },
  sectionSubjects: {
    "cold-start": "启动阶段",
    "hot-path": "场景",
    chain: "链路",
    storage: "操作",
    "hot-path-comparison": "实现",
    "join-log-capacity": "对照点",
  },
  metricLabels: {
    duration: "耗时",
    medianLatency: "中位延迟",
    throughput: "吞吐",
    peakRss: "峰值 RSS",
    retainedHeap: "GC 后留存",
    batchLatency: "批次延迟",
    writtenBytes: "块设备写",
    p50Latency: "p50",
    p95Latency: "p95",
    p99Latency: "p99",
    maxLatency: "最大",
    elapsed: "耗时",
    allocatedHeap: "GC 前分配",
  },
  variationColumn: "波动",
  coldStartCaption:
    "本轮恢复：{whitelist} 条白名单 · {blocklist} 条黑名单 · {chats} 群状态 · " +
    "{memories} 份 AI 记忆快照；进程峰值 RSS {rss}。",
  metricColumn: "指标",
  valueColumn: "读数",
  footer:
    "复现：`bun run perf:full`（仅发布与明确指令时运行）。数据全部落在仓库 `performance/` 下且不进 Git，" +
    "配置读 `config_example/`，跑完即删。",
};

const EN: BenchmarkCopy = {
  summaryPrefix: "Latest full benchmark",
  summaryRounds: "{n}-run mean",
  environmentTitle: "Environment",
  environmentLabels: {
    runtime: "Runtime",
    kernel: "Kernel",
    cpu: "CPU",
    memory: "Memory",
    rounds: "Rounds",
    dataRoot: "Mock data root",
    generatedAt: "Generated at",
  },
  totalsTitle: "Total throughput and I/O (per round)",
  totalsNote:
    "I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children " +
    "(including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. " +
    "Block-device reads staying at zero is expected: fixtures are read right after being written, so everything " +
    "hits the OS page cache, which this benchmark never drops.",
  totalsLabels: {
    measuredOperations: "Measured operations",
    rcharBytes: "Process reads",
    wcharBytes: "Process writes",
    readBytes: "Block-device reads",
    writeBytes: "Block-device writes",
    readSyscalls: "Read syscalls",
    writeSyscalls: "Write syscalls",
    mockRootBytes: "Mock root on disk",
    mockRootFiles: "Mock root files",
  },
  sectionTitles: {
    "cold-start": "Cold path · startup recovery",
    "hot-path": "Hot path · production functions",
    chain: "Chains · end-to-end durability",
    storage: "Storage · SQLite and main-thread caches",
    "hot-path-comparison": "Implementation comparison · containers and algorithms",
    "join-log-capacity": "Join log · 250k capacity line",
  },
  sectionNotes: {
    "cold-start":
      "Real startup recovery over a fully seeded fixture, timed phase by phase in the order of " +
      "`packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) " +
      "and the two business Workers.",
    "hot-path":
      "One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.",
    chain:
      "Every chain is driven through its main-thread production entry against a real Disk I/O Worker, " +
      "timed until the durable acknowledgement.",
    storage:
      "Reuses `bun run perf:identity-database`; \"cold\" means an empty connection page cache and statement cache, " +
      "not a dropped OS page cache.",
    "hot-path-comparison":
      "Two implementations of the same job, meaningful only when choosing between them; this is not production code.",
    "join-log-capacity":
      "`current` is today's implementation; `baseline` freezes the pre-optimisation whole-table copy and sort as a reference.",
  },
  sectionSubjects: {
    "cold-start": "Phase",
    "hot-path": "Scenario",
    chain: "Chain",
    storage: "Operation",
    "hot-path-comparison": "Implementation",
    "join-log-capacity": "Case",
  },
  metricLabels: {
    duration: "Duration",
    medianLatency: "Median latency",
    throughput: "Throughput",
    peakRss: "Peak RSS",
    retainedHeap: "Retained after GC",
    batchLatency: "Batch latency",
    writtenBytes: "Block-device writes",
    p50Latency: "p50",
    p95Latency: "p95",
    p99Latency: "p99",
    maxLatency: "Max",
    elapsed: "Elapsed",
    allocatedHeap: "Allocated before GC",
  },
  variationColumn: "Variation",
  coldStartCaption:
    "Recovered this round: {whitelist} whitelist · {blocklist} blocklist · {chats} chat states · " +
    "{memories} AI memory snapshots; process peak RSS {rss}.",
  metricColumn: "Metric",
  valueColumn: "Value",
  footer:
    "Reproduce with `bun run perf:full` (release and explicit request only). All data lives under the untracked " +
    "`performance/` directory, configuration is read from `config_example/`, and the tree is removed afterwards.",
};

const JA: BenchmarkCopy = {
  summaryPrefix: "直近の全量ベンチマーク",
  summaryRounds: "{n} ラウンドの平均",
  environmentTitle: "実行環境",
  environmentLabels: {
    runtime: "ランタイム",
    kernel: "カーネル",
    cpu: "CPU",
    memory: "メモリ",
    rounds: "ラウンド数",
    dataRoot: "モックデータルート",
    generatedAt: "計測日時",
  },
  totalsTitle: "総スループットと総 I/O（1 ラウンドあたり）",
  totalsNote:
    "I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間" +
    "（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。" +
    "「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュに" +
    "すべて当たる（本ベンチマークはページキャッシュを破棄しない）。",
  totalsLabels: {
    measuredOperations: "計測オペレーション数",
    rcharBytes: "プロセス読み込み",
    wcharBytes: "プロセス書き込み",
    readBytes: "ブロックデバイス読み込み",
    writeBytes: "ブロックデバイス書き込み",
    readSyscalls: "読み込みシステムコール",
    writeSyscalls: "書き込みシステムコール",
    mockRootBytes: "モックルート使用量",
    mockRootFiles: "モックルートファイル数",
  },
  sectionTitles: {
    "cold-start": "コールドパス · 起動リカバリ",
    "hot-path": "ホットパス · 本番関数",
    chain: "チェーン · エンドツーエンドの永続化",
    storage: "ストレージ · SQLite とメインスレッドキャッシュ",
    "hot-path-comparison": "実装比較 · コンテナとアルゴリズム",
    "join-log-capacity": "参加ログ · 25 万件の容量線",
  },
  sectionNotes: {
    "cold-start":
      "満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。" +
      "`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。",
    "hot-path":
      "シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。",
    chain:
      "各チェーンはメインスレッドの本番エントリから実際の Disk I/O Worker を駆動し、永続化の完了応答までを計測する。",
    storage:
      "`bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、" +
      "OS のページキャッシュを破棄したという意味ではない。",
    "hot-path-comparison":
      "同一処理の 2 実装の比較であり、選定時にのみ意味を持つ。本番で動くコードではない。",
    "join-log-capacity":
      "`current` が現行実装、`baseline` は最適化前の全表コピーとソートを固定した計測用の参照。",
  },
  sectionSubjects: {
    "cold-start": "段階",
    "hot-path": "シナリオ",
    chain: "チェーン",
    storage: "操作",
    "hot-path-comparison": "実装",
    "join-log-capacity": "比較対象",
  },
  metricLabels: {
    duration: "所要時間",
    medianLatency: "中央値レイテンシ",
    throughput: "スループット",
    peakRss: "ピーク RSS",
    retainedHeap: "GC 後の残存",
    batchLatency: "バッチ遅延",
    writtenBytes: "ブロックデバイス書き込み",
    p50Latency: "p50",
    p95Latency: "p95",
    p99Latency: "p99",
    maxLatency: "最大",
    elapsed: "所要時間",
    allocatedHeap: "GC 前の割り当て",
  },
  variationColumn: "変動",
  coldStartCaption:
    "このラウンドの復元：ホワイトリスト {whitelist} 件 · ブロックリスト {blocklist} 件 · チャット状態 {chats} 件 · " +
    "AI メモリスナップショット {memories} 件、プロセスのピーク RSS {rss}。",
  metricColumn: "指標",
  valueColumn: "計測値",
  footer:
    "再現方法：`bun run perf:full`（リリース時と明示的な指示時のみ実行）。データはすべて Git 管理外の `performance/` " +
    "配下に置かれ、設定は `config_example/` から読み込み、完了後に削除される。",
};

/** 取某种语言的文案表。 */
export function benchmarkCopy(language: Language): BenchmarkCopy {
  switch (language) {
    case "zh":
      return ZH;
    case "en":
      return EN;
    case "ja":
      return JA;
  }
}
