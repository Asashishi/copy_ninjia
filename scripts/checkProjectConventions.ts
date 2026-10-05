import { existsSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import type ts from "typescript";
import { createModuleGraphReader } from "./conventions/moduleGraph";
import type { ModuleGraphReader } from "./conventions/moduleGraph";
import { parseSourceFile, sourceFilesUnder } from "./conventions/sourceAnalysis";
import {
  collectCacheJsDocProblems,
  collectConstantProblems,
  collectConstantLocationProblems,
  collectDeclarationProblems,
  collectModuleCacheProblems,
  collectObjectFreezeProblems,
} from "./conventions/sourceRules";
import type { SourceFileRuleParams } from "./conventions/sourceRules";
import { collectColdMigrationProblems } from "./conventions/coldMigrations";
import { collectCoverageMetricProblems } from "./conventions/coverageMetrics";
import { collectFaultInjectionSuiteProblems } from "./conventions/faultInjectionSuite";
import { collectFileLengthProblems } from "./conventions/fileLength";
import { collectInstallModuleProblems } from "./conventions/installModules";
import {
  collectUndeclaredDependencyProblems,
  readDeclaredPackages,
} from "./conventions/manifestDependencies";
import { collectPerformanceRecordProblems } from "./conventions/performanceRecord";
import { collectRuntimeCalibrationProblems } from "./perf/hotPaths/gateRuntime";
import {
  CACHE_OWNER_BY_PREFIX,
  CACHE_OWNER_EXEMPTIONS,
  collectCacheOwnerHeaderProblems,
  collectCacheOwnershipProblems,
  collectStaleCacheExemptionProblems,
  THREAD_ENTRY_PATHS,
} from "./conventions/cacheOwnership";
import { collectWorkerTimerProblems } from "./conventions/workerTimers";
import { collectCommentReferenceProblems } from "./conventions/commentReferences";
import {
  collectMarkdownModuleListProblems,
  collectSourceDirectories,
} from "./conventions/markdownModuleLists";
import { collectMarkdownAnchors } from "./conventions/markdownAnchors";
import { withoutMarkdownCodeFences } from "./conventions/markdownSource";
import {
  collectNodeCompatibilityProblems,
  collectNodeImportUsage,
  collectStaleNodeAllowanceProblems,
  collectUnusedNodeAllowanceProblems,
} from "./conventions/nodeCompatibility";
import type { NodeImportUsage } from "./conventions/nodeCompatibility";
import { collectTelegramMessageProblems } from "./conventions/telegramMessages";
import {
  collectConstantValueAssertionProblems,
  collectExportedStringConstants,
  collectStringConstantAssertionProblems,
} from "./conventions/testAssertions";
import {
  collectConstantTextFragmentAssertionProblems,
  collectConstantTextFragments,
  collectUnusedConstantTextExemptionProblems,
  constantTextCorpus,
} from "./conventions/testAssertionFragments";
import {
  collectEnvironmentAccessProblems,
  collectFullSuiteImportProblems,
  collectInfraLayeringProblems,
  collectStatesPurityProblems,
} from "./conventions/moduleBoundaries";

const PROJECT_ROOT: string = join(import.meta.dir, "..");
const CACHE_ROOT: string = join(PROJECT_ROOT, "packages", "cache");
const CONSTS_ROOT: string = join(PROJECT_ROOT, "packages", "consts");
const SOURCE_ROOT: string = join(PROJECT_ROOT, "packages");
const SCRIPTS_ROOT: string = join(PROJECT_ROOT, "scripts");
const TEST_ROOT: string = join(PROJECT_ROOT, "test");
const COMMANDS_ROOT: string = join(SOURCE_ROOT, "commands");
const INFRA_ROOT: string = join(SOURCE_ROOT, "infra");
const STATES_ROOT: string = join(SOURCE_ROOT, "states");
const WORKERS_ROOT: string = join(SOURCE_ROOT, "workers");

/** 检查受跟踪与尚未加入索引的源码；Git 忽略的部署数据不进入清单。 */
function projectFiles(): string[] {
  const result: ReturnType<typeof Bun.spawnSync> = Bun.spawnSync({
    cmd: [
      "git",
      "-c",
      `safe.directory=${PROJECT_ROOT}`,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
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
      `Failed to enumerate project files: ${stderr.trim()}`
    );
  }
  const stdout: string = result.stdout === undefined
    ? ""
    : new TextDecoder().decode(result.stdout);
  return stdout.split("\0").filter(
    (path: string): boolean => path.length > 0
  );
}

/** 每份文档的锚点集合只算一次；同一批检查里多个文件会互相指来指去。 */
const markdownAnchorCache: Map<string, ReadonlySet<string> | null> = new Map();

/** 读取并缓存一份文档的锚点；文件读不到时返回 null（路径那一半另有报错）。 */
async function anchorsOf(path: string): Promise<ReadonlySet<string> | null> {
  const cached: ReadonlySet<string> | null | undefined = markdownAnchorCache.get(path);
  if (cached !== undefined) return cached;
  let anchors: ReadonlySet<string> | null;
  try {
    anchors = collectMarkdownAnchors(await Bun.file(path).text());
  } catch {
    anchors = null;
  }
  markdownAnchorCache.set(path, anchors);
  return anchors;
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
        target.startsWith("/") ||
        target.startsWith("//") ||
        /^[a-z][a-z0-9+.-]*:/i.test(target)
      ) {
        continue;
      }
      const line: number =
        searchable.slice(0, match.index).split("\n").length;
      const fragmentIndex: number = target.indexOf("#");
      const fragment: string = fragmentIndex < 0 ? "" : target.slice(fragmentIndex + 1);
      const targetWithoutFragment: string = target.split(/[?#]/, 1)[0] ?? "";
      // 纯 `#片段` 指向当前文档自己的标题。
      let linkedPath: string = path;
      if (targetWithoutFragment.length > 0) {
        let decodedTarget: string;
        try {
          decodedTarget = decodeURIComponent(targetWithoutFragment);
        } catch {
          decodedTarget = targetWithoutFragment;
        }
        linkedPath = resolve(dirname(path), decodedTarget);
        if (!existsSync(linkedPath)) {
          failures.push(
            `${relative(PROJECT_ROOT, path)}:${line} local link target does not exist: ${target}`
          );
          continue;
        }
      }
      if (fragment.length === 0 || extname(linkedPath) !== ".md") continue;
      let decodedFragment: string;
      try {
        decodedFragment = decodeURIComponent(fragment);
      } catch {
        decodedFragment = fragment;
      }
      const anchors: ReadonlySet<string> | null = await anchorsOf(linkedPath);
      if (anchors === null || anchors.has(decodedFragment.toLowerCase())) continue;
      failures.push(
        `${relative(PROJECT_ROOT, path)}:${line} link fragment has no matching heading in ` +
        `${relative(PROJECT_ROOT, linkedPath)}: #${decodedFragment}`
      );
    }
  }
}

/** 四条线程各自入口的绝对路径；从入口出发构建同线程模块闭包（含最短引入路径）。 */
const THREAD_ENTRIES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(THREAD_ENTRY_PATHS).map(
    ([thread, path]: [string, string]): [string, string] => [thread, join(PROJECT_ROOT, path)]
  )
);

/**
 * Telegram 凭据、真实客户端、网络分派与出站队列只属主线程。Worker 只能加载
 * 项目自有协议和双工代理，连 grammY 运行时都不得进入其模块闭包。
 */
const WORKER_TELEGRAM_FORBIDDEN_MODULES: readonly string[] = [
  join(PROJECT_ROOT, "packages", "cache", "main", "telegram.ts"),
  join(PROJECT_ROOT, "packages", "infra", "telegram", "mainClient.ts"),
  join(PROJECT_ROOT, "packages", "infra", "telegram", "messageThrottler.ts"),
  join(PROJECT_ROOT, "packages", "infra", "telegram", "outboundGate.ts"),
  join(PROJECT_ROOT, "packages", "infra", "telegram", "workerRequests.ts"),
];

const failures: string[] = [];
/** 逐文件遍历时顺带记下的 Node 兼容 import；整趟结束后反向核对登记表。 */
const nodeImportUsage: NodeImportUsage[] = [];
failures.push(...await collectRuntimeCalibrationProblems({ projectRoot: PROJECT_ROOT }));
failures.push(...collectStaleNodeAllowanceProblems(PROJECT_ROOT));
for (const problem of await collectColdMigrationProblems(PROJECT_ROOT)) {
  failures.push(`cold migration: ${problem}`);
}
for (const problem of await collectCoverageMetricProblems(PROJECT_ROOT)) {
  failures.push(problem);
}
for (const problem of await collectFaultInjectionSuiteProblems(PROJECT_ROOT)) {
  failures.push(`fault injection suite: ${problem}`);
}

for (const problem of await collectPerformanceRecordProblems(PROJECT_ROOT)) {
  failures.push(`performance record: ${problem}`);
}
for (const problem of await collectInstallModuleProblems(PROJECT_ROOT)) {
  failures.push(`install script: ${problem}`);
}
// 目录清单核对要按真实目录解析文档里的目录名；整趟只遍历一次，且只走源码根
// （理由见 collectSourceDirectories：仓库根下有部署方数据目录，不能碰）。
const sourceDirectories: readonly string[] = collectSourceDirectories([
  SOURCE_ROOT,
  SCRIPTS_ROOT,
  TEST_ROOT,
]);
const tracked: string[] = projectFiles();
for (const trackedPath of tracked) {
  const path: string = join(PROJECT_ROOT, trackedPath);
  // 允许尚未 stage 的正常删除；其它门禁会从最终工作树/索引确认变更范围。
  if (!existsSync(path)) continue;
  if (/\.(?:[cm]?[jt]sx?|sh)$/.test(path)) {
    failures.push(...collectFileLengthProblems(trackedPath, await Bun.file(path).text()));
  }
  if (extname(path) === ".md") {
    await checkMarkdownLocalLinks(path, failures);
    for (const problem of await collectMarkdownModuleListProblems(
      PROJECT_ROOT,
      path,
      sourceDirectories
    )) {
      failures.push(problem);
    }
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

const cacheFiles: readonly string[] = sourceFilesUnder(CACHE_ROOT);
const cacheFirstLines: Map<string, string> = new Map();
for (const path of cacheFiles) {
  cacheFirstLines.set(path, (await Bun.file(path).text()).split("\n", 1)[0] ?? "");
}
failures.push(...collectCacheOwnerHeaderProblems({ projectRoot: PROJECT_ROOT, firstLines: cacheFirstLines }));
failures.push(...collectStaleCacheExemptionProblems({
  projectRoot: PROJECT_ROOT,
  cacheFiles,
  threadClosures,
  exemptions: CACHE_OWNER_EXEMPTIONS,
}));
for (const problem of collectCacheOwnershipProblems({
  projectRoot: PROJECT_ROOT,
  cacheFiles,
  threadEntries: THREAD_ENTRIES,
  threadClosures,
  ownerByPrefix: CACHE_OWNER_BY_PREFIX,
  exemptions: CACHE_OWNER_EXEMPTIONS,
})) {
  failures.push(problem);
}

const cacheSourceFiles: ReadonlySet<string> = new Set(sourceFilesUnder(CACHE_ROOT));
const constsSourceFiles: ReadonlySet<string> = new Set(sourceFilesUnder(CONSTS_ROOT));
/** 根 manifest 直接声明的包；逐文件核对运行期裸导入时共用。 */
const declaredPackages: ReadonlySet<string> = await readDeclaredPackages(PROJECT_ROOT);
/** packages/consts 导出的字符串常量表（取值 → 常量名），逐文件判定时顺带收集，供测试断言规则比对。 */
const exportedStringConstants: Map<string, string[]> = new Map();
/** packages/consts 全部字符串字面量与模板静态片段，供测试断言的文案片段规则做子串比对。 */
const constantTextFragments: string[] = [];
/** 文案片段规则本次用到的提示词契约豁免（`路径::用例名`），跑完后核对有无闲置条目。 */
const usedConstantTextExemptions: Set<string> = new Set<string>();
/** 注释交叉引用按 basename 兜底解析时的候选集合；生产源码与入口一份就够。 */
const referenceResolutionFiles: readonly string[] = [
  ...sourceFilesUnder(SOURCE_ROOT),
  THREAD_ENTRIES.main!,
];
// 逐文件的源码约定：每个文件**只读一次、只解析一次**，适用的规则全在这一趟里跑完。
// cache/consts 规则按 sourceFilesUnder 的真实文件集合判定适用范围；模块级缓存规则由
// collectModuleCacheProblems 判定。失败列表按文件汇总。
//
// 仓库根的 index.ts 是生产入口，AGENTS.md 多条规则的适用范围写的就是「packages/ 与
// index.ts」；它不在 sourceFilesUnder(SOURCE_ROOT) 里，必须显式并进同一趟判定，
// 否则日志边界、Node 兼容与声明规范在这个文件上没有任何门禁。
for (const path of [...sourceFilesUnder(SOURCE_ROOT), THREAD_ENTRIES.main!]) {
  const source: ts.SourceFile = await parseSourceFile(path);
  const params: SourceFileRuleParams = { projectRoot: PROJECT_ROOT, path, source };
  if (!cacheSourceFiles.has(path) && !constsSourceFiles.has(path)) {
    failures.push(...collectConstantLocationProblems(params));
  }
  for (const problem of collectNodeCompatibilityProblems(PROJECT_ROOT, path, source)) {
    failures.push(problem);
  }
  nodeImportUsage.push(...collectNodeImportUsage(PROJECT_ROOT, path, source));
  failures.push(...collectUndeclaredDependencyProblems({ projectRoot: PROJECT_ROOT, path, source, declaredPackages }));
  if (cacheSourceFiles.has(path)) {
    for (const problem of collectCacheJsDocProblems(params)) failures.push(problem);
  }
  if (constsSourceFiles.has(path)) {
    for (const problem of collectConstantProblems(params)) failures.push(problem);
    collectExportedStringConstants(source, exportedStringConstants);
    collectConstantTextFragments(source, constantTextFragments);
  }
  for (const problem of collectObjectFreezeProblems(params)) failures.push(problem);
  if (!path.startsWith(CACHE_ROOT) && !path.startsWith(CONSTS_ROOT)) {
    for (const problem of collectModuleCacheProblems(params)) failures.push(problem);
  }
  for (const problem of collectDeclarationProblems(params)) failures.push(problem);
  failures.push(...collectEnvironmentAccessProblems(params));
  if (path.startsWith(STATES_ROOT + "/")) {
    failures.push(...collectStatesPurityProblems(params));
  }
  if (path.startsWith(INFRA_ROOT + "/")) {
    failures.push(...collectInfraLayeringProblems(params));
  }
  for (const problem of await collectCommentReferenceProblems({
    projectRoot: PROJECT_ROOT,
    path,
    source,
    allSourceFiles: referenceResolutionFiles,
  })) {
    failures.push(problem);
  }
  if (path.startsWith(WORKERS_ROOT + "/")) {
    for (const problem of collectWorkerTimerProblems(PROJECT_ROOT, path, source)) {
      failures.push(problem);
    }
  }
}

// Node 兼容 import、依赖声明与全量基准 import 边界同时约束 scripts/ 与 test/，测试断言
// 取值口径只约束 test/，其余判定只针对 packages/。
const constantTextCorpusText: string = constantTextCorpus(constantTextFragments);
for (const path of [...sourceFilesUnder(SCRIPTS_ROOT), ...sourceFilesUnder(TEST_ROOT)]) {
  const source: ts.SourceFile = await parseSourceFile(path);
  for (const problem of collectNodeCompatibilityProblems(PROJECT_ROOT, path, source)) {
    failures.push(problem);
  }
  nodeImportUsage.push(...collectNodeImportUsage(PROJECT_ROOT, path, source));
  failures.push(...collectUndeclaredDependencyProblems({ projectRoot: PROJECT_ROOT, path, source, declaredPackages }));
  failures.push(...collectFullSuiteImportProblems({ projectRoot: PROJECT_ROOT, path, source }));
  if (path.startsWith(TEST_ROOT + "/")) {
    failures.push(...collectConstantValueAssertionProblems({ projectRoot: PROJECT_ROOT, path, source }));
    failures.push(...collectStringConstantAssertionProblems({
      projectRoot: PROJECT_ROOT,
      path,
      source,
      constants: exportedStringConstants,
    }));
    failures.push(...collectConstantTextFragmentAssertionProblems({
      projectRoot: PROJECT_ROOT,
      path,
      source,
      corpus: constantTextCorpusText,
      usedExemptions: usedConstantTextExemptions,
    }));
  }
}
failures.push(...collectUnusedConstantTextExemptionProblems(usedConstantTextExemptions));
failures.push(...collectUnusedNodeAllowanceProblems(nodeImportUsage));

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
