/**
 * 基准区块的三语文案表。
 *
 * 稳定 id 仍由渲染层原样输出；本文件只负责标题、列名和口径说明，被测动作的
 * 三语名称集中在 `markdownEntryCopy.ts`。
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
    | "runtime"
    | "kernel"
    | "cpuCores"
    | "memory"
    | "rounds"
    | "dataRoot"
    | "generatedAt",
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
    cpuCores: "CPU 核心数",
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
    chain: "完整流程 · 命令与落盘动作",
    storage: "存储 · SQLite 与主线程缓存",
    "container-algorithm": "容器与算法",
    "join-log-capacity": "入群日志 · 25 万容量线",
  },
  sectionNotes: {
    "cold-start":
      "满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；" +
      "不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。",
    "hot-path":
      "每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。",
    chain:
      "每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。" +
      "前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram " +
      "替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。" +
      "`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。" +
      "它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，" +
      "保留它只会显示产品节奏而不是处理能力。",
    storage:
      "复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。",
    "container-algorithm":
      "生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，" +
      "AI 滚动记忆缓冲用 " +
      "`BoundedDeque`；这里单独量容器本身的成本。",
    "join-log-capacity":
      "25 万条满库入群日志上跑当前实现的快照与容量裁剪。",
  },
  sectionSubjects: {
    "cold-start": "启动阶段",
    "hot-path": "场景",
    chain: "生产动作",
    storage: "操作",
    "container-algorithm": "容器",
    "join-log-capacity": "操作",
  },
  metricLabels: {
    duration: "耗时",
    medianLatency: "典型单次耗时",
    throughput: "每秒调用",
    completedThroughput: "完整处理能力",
    recordThroughput: "业务记录吞吐",
    peakRss: "峰值 RSS",
    retainedHeap: "GC 后留存",
    batchLatency: "平均批次耗时",
    writtenBytes: "块设备写",
    meanLatency: "平均单次耗时",
    p50Latency: "典型单次耗时 (p50)",
    p95Latency: "慢请求耗时 (p95)",
    maxLatency: "最慢单次",
    elapsed: "耗时",
    allocatedHeap: "GC 前分配",
  },
  variationColumn: "波动",
  coldStartCaption:
    "本轮恢复：{whitelist} 条白名单 · {blocklist} 条黑名单 · {chats} 群状态 · " +
    "{qa} 条群问答 · {memories} 份 AI 记忆快照；进程峰值 RSS {rss}。",
  metricColumn: "指标",
  valueColumn: "读数",
  footer: "复现：`bun run perf:full`。",
};

const EN: BenchmarkCopy = {
  summaryPrefix: "Latest full benchmark",
  summaryRounds: "{n}-run mean",
  environmentTitle: "Environment",
  environmentLabels: {
    runtime: "Runtime",
    kernel: "Kernel",
    cpuCores: "CPU cores",
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
    chain: "Complete flows · commands and durable actions",
    storage: "Storage · SQLite and main-thread caches",
    "container-algorithm": "Containers and algorithms",
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
      "Each row runs from a production entry to the completion point stated in its name; \"Complete runs/s\" " +
      "is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker " +
      "and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram " +
      "traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, " +
      "serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force " +
      "the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. " +
      "It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that " +
      "uses no CPU and does not block other chats.",
    storage:
      "Reuses `bun run perf:identity-database`; \"cold\" means an empty connection page cache and statement cache, " +
      "not a dropped OS page cache.",
    "container-algorithm":
      "The containers and algorithms production actually runs on: quota and bounded anti-raid join " +
      "windows use `TimestampDeque`, " +
      "the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.",
    "join-log-capacity":
      "Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.",
  },
  sectionSubjects: {
    "cold-start": "Phase",
    "hot-path": "Scenario",
    chain: "Production action",
    storage: "Operation",
    "container-algorithm": "Container",
    "join-log-capacity": "Operation",
  },
  metricLabels: {
    duration: "Duration",
    medianLatency: "Typical time per call",
    throughput: "Calls per second",
    completedThroughput: "Complete runs/s",
    recordThroughput: "Business records/s",
    peakRss: "Peak RSS",
    retainedHeap: "Retained after GC",
    batchLatency: "Mean batch time",
    writtenBytes: "Block-device writes",
    meanLatency: "Mean time per run",
    p50Latency: "Typical time (p50)",
    p95Latency: "Slow-run time (p95)",
    maxLatency: "Slowest run",
    elapsed: "Elapsed",
    allocatedHeap: "Allocated before GC",
  },
  variationColumn: "Variation",
  coldStartCaption:
    "Recovered this round: {whitelist} whitelist · {blocklist} blocklist · {chats} chat states · " +
    "{qa} chat Q&A entries · {memories} AI memory snapshots; process peak RSS {rss}.",
  metricColumn: "Metric",
  valueColumn: "Value",
  footer: "Reproduce with `bun run perf:full`.",
};

const JA: BenchmarkCopy = {
  summaryPrefix: "直近の全量ベンチマーク",
  summaryRounds: "{n} ラウンドの平均",
  environmentTitle: "実行環境",
  environmentLabels: {
    runtime: "ランタイム",
    kernel: "カーネル",
    cpuCores: "CPU コア数",
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
    chain: "完全処理 · コマンドと永続化アクション",
    storage: "ストレージ · SQLite とメインスレッドキャッシュ",
    "container-algorithm": "コンテナとアルゴリズム",
    "join-log-capacity": "参加ログ · 25 万件の容量線",
  },
  sectionNotes: {
    "cold-start":
      "満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。" +
      "`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。",
    "hot-path":
      "シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。",
    chain:
      "各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。" +
      "先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram " +
      "通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理を" +
      "すべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に" +
      "強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して" +
      "差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。",
    storage:
      "`bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、" +
      "OS のページキャッシュを破棄したという意味ではない。",
    "container-algorithm":
      "本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 " +
      "join ウィンドウは `TimestampDeque`、" +
      "AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。",
    "join-log-capacity":
      "25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。",
  },
  sectionSubjects: {
    "cold-start": "段階",
    "hot-path": "シナリオ",
    chain: "本番アクション",
    storage: "操作",
    "container-algorithm": "コンテナ",
    "join-log-capacity": "操作",
  },
  metricLabels: {
    duration: "所要時間",
    medianLatency: "典型的な 1 回の時間",
    throughput: "毎秒呼び出し数",
    completedThroughput: "完全処理能力",
    recordThroughput: "業務レコード処理能力",
    peakRss: "ピーク RSS",
    retainedHeap: "GC 後の残存",
    batchLatency: "平均バッチ時間",
    writtenBytes: "ブロックデバイス書き込み",
    meanLatency: "平均 1 回時間",
    p50Latency: "典型的な時間 (p50)",
    p95Latency: "低速時の時間 (p95)",
    maxLatency: "最も遅い 1 回",
    elapsed: "所要時間",
    allocatedHeap: "GC 前の割り当て",
  },
  variationColumn: "変動",
  coldStartCaption:
    "このラウンドの復元：ホワイトリスト {whitelist} 件 · ブロックリスト {blocklist} 件 · チャット状態 {chats} 件 · " +
    "チャット Q&A {qa} 件 · AI メモリスナップショット {memories} 件、プロセスのピーク RSS {rss}。",
  metricColumn: "指標",
  valueColumn: "計測値",
  footer: "再現方法：`bun run perf:full`。",
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
