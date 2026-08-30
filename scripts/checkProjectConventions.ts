import { existsSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { createModuleGraphReader } from "./conventions/moduleGraph";
import type { ModuleGraphReader } from "./conventions/moduleGraph";
import { sourceFilesUnder } from "./conventions/sourceAnalysis";
import {
  collectCacheJsDocProblems,
  collectConstantProblems,
  collectDeclarationProblems,
  collectModuleCacheProblems,
  collectObjectFreezeProblems,
} from "./conventions/sourceRules";
import type { SourceFileRuleParams } from "./conventions/sourceRules";
import { collectColdMigrationProblems } from "./conventions/coldMigrations";
import { collectCoverageMetricProblems } from "./conventions/coverageMetrics";
import { collectPerformanceRecordProblems } from "./conventions/performanceRecord";
import { collectCacheOwnershipProblems } from "./conventions/cacheOwnership";
import type { CacheOwnerPrefix } from "./conventions/cacheOwnership";
import { collectNodeCompatibilityProblems } from "./conventions/nodeCompatibility";
import { collectTelegramMessageProblems } from "./conventions/telegramMessages";

const PROJECT_ROOT: string = join(import.meta.dir, "..");
const CACHE_ROOT: string = join(PROJECT_ROOT, "packages", "cache");
const CONSTS_ROOT: string = join(PROJECT_ROOT, "packages", "consts");
const SOURCE_ROOT: string = join(PROJECT_ROOT, "packages");
const SCRIPTS_ROOT: string = join(PROJECT_ROOT, "scripts");
const COMMANDS_ROOT: string = join(SOURCE_ROOT, "commands");

/** 读取 Git 跟踪清单；约定检查只约束会进入提交的文件。 */
function trackedFiles(): string[] {
  const result: ReturnType<typeof Bun.spawnSync> = Bun.spawnSync({
    cmd: [
      "git",
      "-c",
      `safe.directory=${PROJECT_ROOT}`,
      "ls-files",
      "-z",
    ],
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const stderr: string = result.stderr === undefined
      ? ""
      : new TextDecoder().decode(result.stderr);
    throw new Error(
      `Failed to enumerate tracked files: ${stderr.trim()}`
    );
  }
  const stdout: string = result.stdout === undefined
    ? ""
    : new TextDecoder().decode(result.stdout);
  return stdout.split("\0").filter(
    (path: string): boolean => path.length > 0
  );
}

/** 去掉 fenced code block 内容但保留换行和下标，避免把示例语法当成真实链接。 */
function withoutMarkdownCodeFences(source: string): string {
  return source.replace(
    /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g,
    (block: string): string => block.replace(/[^\n]/g, " ")
  );
}

/** 检查 Markdown inline/reference link 与 HTML href/src 的本地目标。 */
async function checkMarkdownLocalLinks(
  path: string,
  failures: string[]
): Promise<void> {
  const source: string = await Bun.file(path).text();
  const searchable: string = withoutMarkdownCodeFences(source);
  const patterns: readonly RegExp[] = [
    /!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g,
    /(?:href|src)=["']([^"']+)["']/g,
    /^\s*\[[^\]\n]+\]:\s*<?(\S+?)>?(?:\s+["'(].*)?$/gm,
  ];
  for (const pattern of patterns) {
    for (const match of searchable.matchAll(pattern)) {
      const target: string | undefined = match[1];
      if (
        target === undefined ||
        target.startsWith("#") ||
        target.startsWith("/") ||
        target.startsWith("//") ||
        /^[a-z][a-z0-9+.-]*:/i.test(target)
      ) {
        continue;
      }
      const targetWithoutFragment: string = target.split(/[?#]/, 1)[0] ?? "";
      if (targetWithoutFragment.length === 0) continue;
      let decodedTarget: string;
      try {
        decodedTarget = decodeURIComponent(targetWithoutFragment);
      } catch {
        decodedTarget = targetWithoutFragment;
      }
      if (existsSync(resolve(dirname(path), decodedTarget))) continue;
      const line: number =
        searchable.slice(0, match.index).split("\n").length;
      failures.push(
        `${relative(PROJECT_ROOT, path)}:${line} local link target does not exist: ${target}`
      );
    }
  }
}

/** 四条线程各自的入口，以及从入口出发能加载到的模块闭包（含最短引入路径）。 */
const THREAD_ENTRIES: Readonly<Record<string, string>> = {
  main: join(PROJECT_ROOT, "index.ts"),
  aiChat: join(PROJECT_ROOT, "packages", "workers", "aiChatWorker.ts"),
  antiRaid: join(PROJECT_ROOT, "packages", "workers", "antiRaidWorker.ts"),
  diskIO: join(PROJECT_ROOT, "packages", "workers", "diskIOWorker.ts"),
};

/**
 * `packages/cache/` 的目录名就是这份状态的 owner 线程，见
 * docs/cn/04-invariants.md「缓存的线程归属」。这里用真实模块图核对声明与事实是否
 * 一致：一份只属于某条线程的状态被别的线程 import，那条线程拿到的是一份永远
 * 对不上的空副本——静态看不出来，运行起来只是「缓存莫名其妙不命中」。
 */
const CACHE_OWNER_BY_PREFIX: readonly CacheOwnerPrefix[] = [
  [join("packages", "cache", "main") + "/", "main"],
  [join("packages", "cache", "workers", "aiChat") + "/", "aiChat"],
  [join("packages", "cache", "workers", "antiRaid") + "/", "antiRaid"],
  [join("packages", "cache", "workers", "diskIO") + "/", "diskIO"],
];

/**
 * 唯一的归属豁免：infra/logger.ts 静态 import infra/diskIO.ts 取 relayLogMessage，
 * 而四条线程都要能记 error 日志。Worker isolate 里那份状态恒为初始值、一次也不
 * 会被读写，理由见 packages/cache/main/diskIO.ts 的模块头注。
 */
const CACHE_OWNER_EXEMPTIONS: Readonly<Record<string, readonly string[]>> = {
  [join("packages", "cache", "main", "diskIO.ts")]: ["aiChat", "antiRaid"],
};

/**
 * Telegram 凭据、真实客户端、网络分派与出站队列只属主线程。Worker 只能加载
 * 项目自有协议和双工代理，连 grammY 运行时都不得进入其模块闭包。
 */
const WORKER_TELEGRAM_FORBIDDEN_MODULES: readonly string[] = [
  join(PROJECT_ROOT, "packages", "config", "telegram.ts"),
  join(PROJECT_ROOT, "packages", "cache", "main", "telegram.ts"),
  join(PROJECT_ROOT, "packages", "infra", "telegram", "mainClient.ts"),
  join(PROJECT_ROOT, "packages", "infra", "telegram", "messageThrottler.ts"),
  join(PROJECT_ROOT, "packages", "infra", "telegram", "outboundGate.ts"),
  join(PROJECT_ROOT, "packages", "infra", "telegram", "workerRequests.ts"),
];

const failures: string[] = [];
for (const problem of await collectColdMigrationProblems(PROJECT_ROOT)) {
  failures.push(`cold migration: ${problem}`);
}
for (const problem of await collectCoverageMetricProblems(PROJECT_ROOT)) {
  failures.push(problem);
}

for (const problem of await collectPerformanceRecordProblems(PROJECT_ROOT)) {
  failures.push(`performance record: ${problem}`);
}
const tracked: string[] = trackedFiles();
for (const trackedPath of tracked) {
  const path: string = join(PROJECT_ROOT, trackedPath);
  // 允许尚未 stage 的正常删除；其它门禁会从最终工作树/索引确认变更范围。
  if (!existsSync(path)) continue;
  if (extname(path) === ".md") {
    await checkMarkdownLocalLinks(path, failures);
  }
  const extension: string = extname(path);
  if (![".ts", ".json", ".md", ".yaml", ".yml"].includes(extension)) continue;
  const stats: ReturnType<typeof statSync> = statSync(path);
  if (!stats.isFile() || (stats.mode & 0o111) === 0) continue;
  if ((await Bun.file(path).text()).startsWith("#!")) continue;
  failures.push(
    `${trackedPath} is a tracked non-script ${extension} file with executable permissions`
  );
}

const moduleGraph: ModuleGraphReader = createModuleGraphReader();
const threadClosures: Map<string, Map<string, string[]>> = new Map();
for (const [thread, entry] of Object.entries(THREAD_ENTRIES)) {
  threadClosures.set(thread, await moduleGraph.threadModuleClosure(entry));
}

for (const [thread, closure] of threadClosures) {
  if (thread === "main") continue;
  for (const forbidden of WORKER_TELEGRAM_FORBIDDEN_MODULES) {
    const trail: string[] | undefined = closure.get(forbidden);
    if (trail === undefined) continue;
    failures.push(
      `${thread} Worker loads main-thread Telegram module: ` +
      trail.map((step: string): string => relative(PROJECT_ROOT, step)).join(" -> ")
    );
  }
  for (const [path, trail] of closure) {
    for (const dependency of await moduleGraph.externalDependencies(path)) {
      if (dependency !== "grammy" && !dependency.startsWith("@grammyjs/")) continue;
      failures.push(
        `${thread} Worker loads Telegram runtime package ${dependency}: ` +
        trail.map((step: string): string => relative(PROJECT_ROOT, step)).join(" -> ")
      );
    }
  }
}

for (const problem of collectCacheOwnershipProblems({
  projectRoot: PROJECT_ROOT,
  cacheFiles: sourceFilesUnder(CACHE_ROOT),
  threadEntries: THREAD_ENTRIES,
  threadClosures,
  ownerByPrefix: CACHE_OWNER_BY_PREFIX,
  exemptions: CACHE_OWNER_EXEMPTIONS,
})) {
  failures.push(problem);
}

/** 解析一个源文件；每个文件在整次检查里只走这一次。 */
async function parseSourceFile(path: string): Promise<ts.SourceFile> {
  return ts.createSourceFile(
    path,
    await Bun.file(path).text(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

/**
 * 逐文件的源码约定：每个文件**只读一次、只解析一次**，适用的规则全在这一趟里跑完。
 *
 * 合并前这里是六趟独立循环（cache JSDoc、consts 常量、Object.freeze、模块级缓存、
 * Node 兼容 import、声明规范），同一个文件被重复读盘与重复建 AST 五到六次。判定
 * 口径与适用集合都没有变化，只是把「按检查分组遍历」换成了「按文件分组遍历」——
 * 因此失败列表现在按文件聚在一起，而不是按检查聚在一起。
 *
 * cache/consts 两条规则按**同一份 sourceFilesUnder 结果**判定适用范围，而不是按路径
 * 前缀猜：`packages/cacheX.ts` 这种同前缀但不在目录里的文件，前缀写法会把它误判进去。
 * 模块级缓存那条的排除条件保持合并前的裸前缀写法，一个字不动。
 */
const cacheSourceFiles: ReadonlySet<string> = new Set(sourceFilesUnder(CACHE_ROOT));
const constsSourceFiles: ReadonlySet<string> = new Set(sourceFilesUnder(CONSTS_ROOT));
// 仓库根的 index.ts 是生产入口，AGENTS.md 多条规则的适用范围写的就是「packages/ 与
// index.ts」；它不在 sourceFilesUnder(SOURCE_ROOT) 里，必须显式并进同一趟判定，
// 否则日志边界、Node 兼容与声明规范在这个文件上没有任何门禁。
for (const path of [...sourceFilesUnder(SOURCE_ROOT), THREAD_ENTRIES.main!]) {
  const source: ts.SourceFile = await parseSourceFile(path);
  const params: SourceFileRuleParams = { projectRoot: PROJECT_ROOT, path, source };
  for (const problem of collectNodeCompatibilityProblems(PROJECT_ROOT, path, source)) {
    failures.push(problem);
  }
  if (cacheSourceFiles.has(path)) {
    for (const problem of collectCacheJsDocProblems(params)) failures.push(problem);
  }
  if (constsSourceFiles.has(path)) {
    for (const problem of collectConstantProblems(params)) failures.push(problem);
  }
  for (const problem of collectObjectFreezeProblems(params)) failures.push(problem);
  if (!path.startsWith(CACHE_ROOT) && !path.startsWith(CONSTS_ROOT)) {
    for (const problem of collectModuleCacheProblems(params)) failures.push(problem);
  }
  for (const problem of collectDeclarationProblems(params)) failures.push(problem);
}

// Node 兼容 import 是唯一同时约束 scripts/ 的规则，其余判定只针对 packages/。
for (const path of sourceFilesUnder(SCRIPTS_ROOT)) {
  const source: ts.SourceFile = await parseSourceFile(path);
  for (const problem of collectNodeCompatibilityProblems(PROJECT_ROOT, path, source)) {
    failures.push(problem);
  }
}

for (const problem of await collectTelegramMessageProblems(
  PROJECT_ROOT,
  SOURCE_ROOT,
  COMMANDS_ROOT
)) {
  failures.push(problem);
}

if (failures.length > 0) {
  console.error(`Project convention check failed with ${failures.length} issue(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Project convention check passed.");
}
