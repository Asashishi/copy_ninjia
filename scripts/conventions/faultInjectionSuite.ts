import { existsSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import type ts from "typescript";
import { parseSourceFile, runtimeModuleReferences, sourceFilesUnder } from "./sourceAnalysis";
import type { RuntimeModuleReference } from "./sourceAnalysis";

/**
 * `bun run test:fault-injection` 的清单必须覆盖全部持久化 / 停机 / Worker 生命周期用例。
 *
 * 清单手工维护在 `package.json` 里，而它就是这套套件的唯一权威（三份
 * `05-dev-workflow.md` 都写「完整清单见 package.json 的脚本定义」）。漏登记不会让任何
 * 门禁变红，套件却在无声中变窄——合入前跑的那一套不再覆盖新写的落盘或重建用例。
 *
 * 本模块按测试 harness 与生产恢复/生命周期边界的值导入给出机器可判的下界。
 * 归属按解析后的路径判定，包含动态 import 与目录入口 `index.ts`，忽略纯类型引用。
 * 兼容入口这类混合主题模块可把边界限定到具体导出：只有取用其中之一（命名空间按
 * 属性访问判定），或以无法静态确定取用范围的形态引用时，才要求登记。
 *
 * 判定只做下界，不禁止清单里出现别的文件：不依赖 harness 的故障注入用例（例如
 * readiness mock 整文件生效的那种）同样该进清单，但没有机器可判的特征，仍由维护者
 * 按 AGENTS.md 的「涉及持久化、停机或 Worker 生命周期」自行判断。
 */

/** 受约束的恢复和生命周期边界，包含生产模块及测试 harness。 */
interface FaultInjectionBoundary {
  /** 仓库相对路径；缺失即判失败，避免改名后判定静默失效。 */
  readonly path: string;
  /** 该边界覆盖的故障面，用于失败文案。 */
  readonly purpose: string;
  /** 只有取用这些导出才计入；缺省表示对该模块的任何运行期引用都计入。 */
  readonly exports?: readonly string[];
}

interface ProjectPackageJson {
  readonly scripts?: Readonly<Record<string, string>>;
}

/**
 * 判定所依据的恢复和生命周期边界清单。
 *
 * 只收「主题就是持久化 / 停机 / Worker 生命周期」的那几个。刻意不收
 * `verificationEffectsHarness`（验证副作用解释器，主题是踢人与删消息）和
 * `adDetectQueueHarness`（广告判定队列随 isolate 生死、主线程不做镜像，见
 * `packages/cache/workers/antiRaid/adDetect.ts` 的模块头注）：它们不落盘，
 * 进这套套件只会拖长发布前的必跑面而换不到恢复能力。
 */
export const FAULT_INJECTION_BOUNDARIES: readonly FaultInjectionBoundary[] = [
  { path: "scripts/migrateTranslateSessions.ts", purpose: "translation session cold migration integrity and interruption recovery" },
  {
    path: "test/helpers/diskIOWorkerHarness.ts",
    purpose: "Disk I/O Worker initialization, backpressure, diagnostic restart and give-up",
  },
  {
    path: "test/helpers/antiRaidMirrorHarness.ts",
    purpose: "Anti-Raid main-thread mirror durability barriers and rebuild recovery",
  },
  {
    path: "test/helpers/blocklistSweepHarness.ts",
    purpose: "blocklist sweep and removal-outbox startup recovery and write-off",
  },
  {
    path: "test/helpers/lifecycleFixture.ts",
    purpose: "application startup and shutdown lifecycle failure injection",
  },
  { path: "packages/workers/diskIO/luckSecretFile.ts", purpose: "luck secret atomic publication and recovery" },
  { path: "packages/workers/diskIO/snapshotFiles.ts", purpose: "snapshot inspect, adoption and recovery maintenance" },
  { path: "packages/workers/aiChat/replyPipeline.ts", purpose: "reply admission, draining and cancellation" },
  { path: "packages/workers/aiChat/replyRound.ts", purpose: "reply model, action and resource lifecycle" },
  { path: "packages/workers/aiChat/replyDelivery.ts", purpose: "reply delivery capacity and generation cleanup" },
  { path: "packages/workers/antiRaid/lockdownRuntime.ts", purpose: "lockdown durable acknowledgements, restore and teardown" },
  { path: "packages/workers/antiRaid/lockdownApi.ts", purpose: "lockdown API ownership and permission compensation" },
  { path: "packages/states/lockdown.ts", purpose: "lockdown recovery and durable state transitions" },
  { path: "packages/aiChat/ai/weather.ts", purpose: "weather refresh cancellation and late-result ownership" },
  { path: "packages/infra/telegram/outboundLifecycle.ts", purpose: "Telegram outbound drain, quiesce and timeout abort" },
  {
    path: "packages/infra/telegram/actions/messageLifecycle.ts",
    purpose: "delayed message deletion shutdown flush and drain",
    exports: ["drainPendingMessageDeletions", "flushPendingMessageDeletions"],
  },
  {
    path: "packages/infra/telegram/actions.ts",
    purpose: "delayed message deletion shutdown flush and drain",
    exports: ["drainPendingMessageDeletions", "flushPendingMessageDeletions"],
  },
  {
    path: "packages/infra/telegram/index.ts",
    purpose: "delayed message deletion shutdown drain",
    exports: ["drainPendingMessageDeletions"],
  },
  { path: "packages/libs/drainWaiter.ts", purpose: "drain waiter settlement and timeout" },
  { path: "packages/infra/supervisedDuplexWorker.ts", purpose: "duplex Worker rebuild cancellation and generation-scoped replies" },
  { path: "packages/infra/chatTeardown.ts", purpose: "combined chat teardown ordering and failure propagation" },
  { path: "packages/infra/joinLog.ts", purpose: "join-log durable barrier and teardown purge" },
  { path: "packages/workers/antiRaid/taskTracker.ts", purpose: "Anti-Raid task draining, dispatch quiesce and generation isolation" },
  {
    path: "packages/workers/antiRaid/verificationRuntime.ts",
    purpose: "verification adoption, persisted terminal resume and generation isolation",
  },
  { path: "packages/infra/storage/instanceLock.ts", purpose: "single-instance lock acquisition, stale-owner recovery and release" },
  { path: "packages/app/lifecycle/shutdown.ts", purpose: "application shutdown ordering, drain budgets and final flush" },
];

/** 该引用是否触及边界：未限定导出的边界按整模块计，无法确定取用范围的引用同样计入。 */
function usesBoundary(reference: RuntimeModuleReference, boundary: FaultInjectionBoundary): boolean {
  if (boundary.exports === undefined || reference.names === null) return true;
  return reference.names.some((name: string): boolean => boundary.exports?.includes(name) === true);
}

/**
 * 相对说明符解析成绝对 `.ts` 路径，供与 harness 的真实路径比对：优先 `<说明符>.ts`，
 * 不存在时取目录入口 `<说明符>/index.ts`。
 *
 * 按**路径**而不是按基名比对：同名不同目录的模块不该被误判成 harness。裸说明符
 * （`bun:test`、`grammy/types`）返回 undefined，直接跳过。
 */
function resolvedSpecifierPath(importerPath: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const resolved: string = resolve(dirname(importerPath), specifier);
  if (extname(resolved) === ".ts") return resolved;
  const file: string = `${resolved}.ts`;
  const directoryEntry: string = join(resolved, "index.ts");
  return !existsSync(file) && existsSync(directoryEntry) ? directoryEntry : file;
}

/** 核对清单里声明的每条路径都真实存在且只出现一次。 */
function collectListedPathProblems(
  projectRoot: string,
  listed: readonly string[]
): readonly string[] {
  const problems: string[] = [];
  const seen: Set<string> = new Set<string>();
  for (const path of listed) {
    if (seen.has(path)) problems.push(`test:fault-injection lists ${path} more than once`);
    seen.add(path);
    if (!existsSync(join(projectRoot, path))) {
      problems.push(`test:fault-injection lists a file that does not exist: ${path}`);
    }
  }
  return problems;
}

/**
 * 核对 `test:fault-injection` 的清单：声明的路径都存在且不重复，且每个使用受约束
 * 恢复和生命周期边界的用例文件都已登记。
 */
export async function collectFaultInjectionSuiteProblems(
  projectRoot: string
): Promise<readonly string[]> {
  const manifest: ProjectPackageJson = JSON.parse(
    await Bun.file(join(projectRoot, "package.json")).text()
  ) as ProjectPackageJson;
  const command: string | undefined = manifest.scripts?.["test:fault-injection"];
  if (command === undefined) {
    return ["package.json must define the test:fault-injection script"];
  }
  const listed: readonly string[] = command.split(/\s+/).filter(
    (token: string): boolean => token.endsWith(".test.ts")
  );
  const problems: string[] = [...collectListedPathProblems(projectRoot, listed)];
  const listedSet: ReadonlySet<string> = new Set<string>(listed);
  const requiredModules: Map<string, FaultInjectionBoundary> = new Map();
  for (const harness of FAULT_INJECTION_BOUNDARIES) {
    const harnessPath: string = join(projectRoot, harness.path);
    if (!existsSync(harnessPath)) {
      problems.push(`declared fault-injection boundary does not exist: ${harness.path}`);
      continue;
    }
    requiredModules.set(harnessPath, harness);
  }
  const testRoot: string = join(projectRoot, "test");
  if (!existsSync(testRoot)) {
    problems.push("test directory does not exist; the fault-injection suite cannot be verified");
    return problems;
  }
  for (const path of sourceFilesUnder(testRoot)) {
    if (!path.endsWith(".test.ts")) continue;
    const relativePath: string = relative(projectRoot, path);
    if (listedSet.has(relativePath)) continue;
    const source: ts.SourceFile = await parseSourceFile(path);
    for (const reference of runtimeModuleReferences(source)) {
      const resolved: string | undefined = resolvedSpecifierPath(path, reference.specifier);
      if (resolved === undefined) continue;
      const harness: FaultInjectionBoundary | undefined = requiredModules.get(resolved);
      if (harness === undefined || !usesBoundary(reference, harness)) continue;
      problems.push(
        `${relativePath} uses ${harness.path} (${harness.purpose}) ` +
        "but is missing from the test:fault-injection script"
      );
      break;
    }
  }
  return problems;
}
