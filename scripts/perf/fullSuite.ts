/**
 * 全量性能基准入口。
 *
 * 只在发布或明确指令时运行：一次完整跑要几分钟、要拉起上百个子进程，它不属于
 * `bun run check` 那一档随手可跑的门禁（热路径的 GC/RSS/JIT 硬门禁仍由
 * `bun run perf:hot-path-gate` 承担，本脚本不重复那件事，也不设失败阈值）。
 *
 * 覆盖六个分区：冷启动、生产热路径、端到端落盘链路、SQLite 与主线程缓存、
 * 容器与算法、入群日志容量线。每一项都在独立子进程里跑三轮，报告给平均值、
 * 最小值、最大值与变异系数。
 *
 * 数据一律落在仓库根的 `performance/` 下（不进 Git），配置从 `config_example/`
 * 复制到本次运行目录并换成非占位夹具凭据，每轮跑完整棵删除。父进程刻意不
 * import 任何生产实现模块，因此它自己**没有能力**写到真实数据根。
 *
 * 用法：
 *   bun run perf:full                  跑完把 JSON 报告打到 stdout
 *   bun run perf:full -- --markdown    再附带打印简体中文 Markdown 区块
 *   bun run perf:full -- --write-doc     跑完把三语区块写回 docs/<lang>/09-performance.md，
 *                                        并把结构化报告记进仓库根 performance-result.json
 */

import { arch, cpus, platform, release, totalmem } from "node:os";
import { FULL_SUITE_ROUNDS } from "./fullSuite/constants";
import {
  addProcessIo,
  emptyProcessIo,
} from "./fullSuite/processIo";
import { PERFORMANCE_MOCK_ROOT_NAME } from "./fullSuite/constants";
import {
  createBenchmarkConfigRoot,
  createRunRoot,
  removeMockPath,
} from "./fullSuite/mockRoot";
import {
  CHAIN_NAMES,
  CONTAINER_ALGORITHM_SCENARIOS,
  PRODUCTION_HOT_PATH_SCENARIOS,
  runChainSection,
  runColdStartSection,
  runHotPathSection,
  runJoinLogSection,
  runStorageSection,
} from "./fullSuite/sections";
import { renderBenchmarkBlock } from "./fullSuite/markdown";
import { writeBenchmarkDocPages } from "./fullSuite/docPage";
import {
  PERFORMANCE_RESULT_PATH,
  writePerformanceResultEntry,
} from "./performanceResult";
import type { ColdStartSectionResult, SectionContext } from "./fullSuite/sections";
import type { DirectoryFootprint } from "./fullSuite/processIo";
import type {
  BenchmarkSection,
  FullSuiteReport,
  ProcessIoDelta,
  SuiteEnvironment,
} from "./fullSuite/types";

export interface SuiteOptions {
  readonly rounds: number;
  readonly markdown: boolean;
  readonly writeDoc: boolean;
}

function parseRounds(value: string | undefined): number {
  const rounds: number = Number(value);
  if (!Number.isSafeInteger(rounds) || rounds < 1) {
    throw new Error("--rounds expects a positive integer.");
  }
  return rounds;
}

/**
 * 解析父进程参数。
 *
 * `--rounds` 只为本地排查而存在；发布必须用默认的三轮，别的轮数出来的数不进
 * README（口径见 AGENTS.md 的发布流程）。
 */
export function parseOptions(argv: readonly string[]): SuiteOptions {
  let rounds: number = FULL_SUITE_ROUNDS;
  let markdown: boolean = false;
  let writeDoc: boolean = false;
  for (let index: number = 0; index < argv.length; index += 1) {
    const argument: string | undefined = argv[index];
    // `bun run perf:full -- --write-doc` 会把那个孤立的 `--` 一并传下来；
    // 它是 bun 的参数分隔符，不是本脚本的选项。
    if (argument === "--") continue;
    if (argument === "--markdown") markdown = true;
    else if (argument === "--write-doc") writeDoc = true;
    else if (argument === "--rounds") {
      index += 1;
      rounds = parseRounds(argv[index]);
    } else {
      throw new Error(
        `Unknown option ${String(argument)}; expected --markdown, --write-doc or --rounds <n>.`
      );
    }
  }
  return { rounds, markdown, writeDoc };
}

function suiteEnvironment(): SuiteEnvironment {
  return {
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    platform: platform(),
    arch: arch(),
    kernel: release(),
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
  };
}

/** 去掉毫秒的 ISO 时间戳；README 的 diff 不该因为毫秒位每次都变。 */
function generatedAt(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

async function runSuite(options: SuiteOptions): Promise<FullSuiteReport> {
  const startedAtNs: number = Bun.nanoseconds();
  const runRoot: string = createRunRoot();
  let configRoot: string;
  try {
    configRoot = await createBenchmarkConfigRoot(runRoot);
  } catch (error: unknown) {
    removeMockPath(runRoot);
    throw error;
  }
  let io: ProcessIoDelta = emptyProcessIo();
  let operations: number = 0;
  let footprint: DirectoryFootprint = { bytes: 0, files: 0 };
  const context: SectionContext = {
    runRoot,
    configRoot,
    rounds: options.rounds,
    onProgress: (message: string): void => {
      console.error(`perf:full ${message}`);
    },
    recordIo: (delta: ProcessIoDelta): void => {
      io = addProcessIo(io, delta);
    },
    recordOperations: (count: number): void => {
      operations += count;
    },
    recordFootprint: (measured: DirectoryFootprint): void => {
      // 累加而不是取最大：这一项回答的是「跑一遍基准总共在 mock 根里落了多少
      // 东西」，各分区的数据根是先后建删的，只报其中最大的那个会漏掉其余全部。
      footprint = {
        bytes: footprint.bytes + measured.bytes,
        files: footprint.files + measured.files,
      };
    },
  };
  try {
    const coldStart: ColdStartSectionResult = await runColdStartSection(context);
    const sections: BenchmarkSection[] = [coldStart.section];
    sections.push(await runHotPathSection(
      context,
      "hot-path",
      PRODUCTION_HOT_PATH_SCENARIOS
    ));
    sections.push(await runChainSection(context));
    sections.push(await runStorageSection(context));
    sections.push(await runHotPathSection(
      context,
      "container-algorithm",
      CONTAINER_ALGORITHM_SCENARIOS
    ));
    sections.push(await runJoinLogSection(context));
    return {
      generatedAt: generatedAt(),
      rounds: options.rounds,
      wallClockMs: (Bun.nanoseconds() - startedAtNs) / 1_000_000,
      mockDataRoot: PERFORMANCE_MOCK_ROOT_NAME,
      environment: suiteEnvironment(),
      sections,
      coldStart: coldStart.summary,
      totals: {
        measuredOperations: operations / options.rounds,
        rcharBytes: io.rcharBytes / options.rounds,
        wcharBytes: io.wcharBytes / options.rounds,
        readBytes: io.readBytes / options.rounds,
        writeBytes: io.writeBytes / options.rounds,
        readSyscalls: io.readSyscalls / options.rounds,
        writeSyscalls: io.writeSyscalls / options.rounds,
        mockRootBytes: footprint.bytes / options.rounds,
        mockRootFiles: footprint.files / options.rounds,
      },
    };
  } finally {
    // 本次运行目录整棵删掉；`performance/` 本身保留，方便并存历史运行的残留。
    removeMockPath(runRoot);
  }
}

/**
 * 子进程模块的统一形状。
 *
 * 四个子进程模块都只对外暴露一个 `main`；用同一个结构类型接住，父进程就不必
 * 为了拿类型去 import 它们的实现——那正是本文件绝不能做的事。
 */
interface ChildModule {
  readonly main: (argument: string | undefined) => Promise<void>;
}

async function runChild(
  kind: string | undefined,
  argument: string | undefined
): Promise<void> {
  switch (kind) {
    case "seed": {
      const child: ChildModule = await import("./fullSuite/seed");
      return child.main(argument);
    }
    case "cold-start": {
      const child: ChildModule = await import("./fullSuite/coldStart");
      return child.main(argument);
    }
    case "chain": {
      const child: ChildModule = await import("./fullSuite/chain");
      return child.main(argument);
    }
    case "storage": {
      const child: ChildModule = await import("./fullSuite/storage");
      return child.main(argument);
    }
    default:
      throw new Error(
        `--child expects seed|cold-start|chain|storage, received ${String(kind)}.`
      );
  }
}

/** `--write-doc` 绑定的两份持久化输出；测试注入记录器验证两者不可拆开。 */
export interface SuiteDocumentWriters {
  readonly writeBenchmarkDocPages: typeof writeBenchmarkDocPages;
  readonly writePerformanceResultEntry: typeof writePerformanceResultEntry;
}

const DEFAULT_SUITE_DOCUMENT_WRITERS: SuiteDocumentWriters = {
  writeBenchmarkDocPages,
  writePerformanceResultEntry,
};

/** 同一次报告同步三语页面和结构化结果，并返回被更新的页面路径。 */
export async function writeSuiteDocuments(
  report: FullSuiteReport,
  writers: SuiteDocumentWriters = DEFAULT_SUITE_DOCUMENT_WRITERS
): Promise<readonly string[]> {
  const paths: readonly string[] = await writers.writeBenchmarkDocPages(report);
  await writers.writePerformanceResultEntry({
    path: PERFORMANCE_RESULT_PATH,
    section: "fullSuite",
    entry: "lastRun",
    value: report,
  });
  return paths;
}

/** 父进程与子进程共用的 CLI 入口；模块导入不执行基准。 */
export async function main(argv: readonly string[]): Promise<void> {
  if (argv[0] === "--child") {
    await runChild(argv[1], argv[2]);
    return;
  }
  const options: SuiteOptions = parseOptions(argv);
  const report: FullSuiteReport = await runSuite(options);
  await Bun.write(Bun.stdout, `${JSON.stringify(report, null, 2)}\n`);
  if (options.markdown) {
    await Bun.write(Bun.stdout, `\n${renderBenchmarkBlock(report, "zh")}\n`);
  }
  if (options.writeDoc) {
    for (const path of await writeSuiteDocuments(report)) {
      console.error(`perf:full wrote benchmark block to ${path}`);
    }
    console.error(`perf:full recorded this run into ${PERFORMANCE_RESULT_PATH}`);
  }
  console.error(
    `perf:full finished ${CHAIN_NAMES.length} chains and ` +
    `${PRODUCTION_HOT_PATH_SCENARIOS.length + CONTAINER_ALGORITHM_SCENARIOS.length} ` +
    `hot-path scenarios in ${(report.wallClockMs / 1_000).toFixed(1)}s`
  );
}

if (import.meta.main) await main(Bun.argv.slice(2));
