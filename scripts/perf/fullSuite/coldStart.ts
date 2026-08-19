/**
 * 冷启动子进程：按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时。
 *
 * **本文件不得静态 import 任何 `packages/` 下的模块。** 模块图加载是被测的第
 * 一段，静态 import 会让它在计时开始前就完成，那一段读数会退化成 0，后面各段
 * 也拿不到「刚启动的进程」该有的冷状态。
 *
 * 覆盖范围要说清楚：这里只跑到「持久化恢复就绪」，不含 `bot.init()`、命令菜单
 * 注册、黑名单补扫这些需要联网的握手，也不含 AI/Anti-Raid 两个业务 Worker 的
 * 创建（它们要等 `bot.botInfo`）。落盘与解析之外的启动成本不在本读数里。
 */

import { assertBenchmarkRuntimeRoot } from "./mockRoot";
import {
  diffProcessIo,
  readProcessIo,
} from "./processIo";
import type { ProcessIoSnapshot } from "./processIo";
// 只导类型：`import type` 在运行期被完全擦除，不会把生产模块图提前拉进来，
// 因此它不违反本文件「不静态 import 生产模块」的约束。
import type { ApplicationLifecycleDependencies } from
  "../../../packages/app/lifecycleDependencies";
import type { LoadedData } from "../../../packages/types/diskIO";
import type {
  ColdStartPhaseTimings,
  ColdStartRecovered,
  ColdStartRound,
} from "./types";

function elapsedMsSince(startedAtNs: number): number {
  return (Bun.nanoseconds() - startedAtNs) / 1_000_000;
}

/**
 * 跑一次冷启动并逐段计时。
 *
 * 各段之间不插 GC、不清缓存：生产启动同样是一段接一段跑下来的，人为在中间
 * 制造干净现场量到的是一条谁都走不到的路径。
 */
async function runColdStartChild(): Promise<ColdStartRound> {
  const io: ProcessIoSnapshot = readProcessIo();

  const moduleStartedAtNs: number = Bun.nanoseconds();
  const lifecycleDependencies: ApplicationLifecycleDependencies = (
    await import("../../../packages/app/lifecycleDependencies")
  ).lifecycleDependencies;
  const moduleGraphMs: number = elapsedMsSince(moduleStartedAtNs);

  // 模块图一到手就堵死出站：下面每一段都只该碰本地文件，任何一次真实出站都会
  // 以线上机器人的身份发出去。
  const installOutboundGuards: () => void = (
    await import("../outboundGuard")
  ).installOutboundGuards;
  installOutboundGuards();
  const runtimeDataRoot: string = (
    await import("../../../packages/consts/paths")
  ).RUNTIME_DATA_ROOT;
  assertBenchmarkRuntimeRoot(runtimeDataRoot);

  const lockStartedAtNs: number = Bun.nanoseconds();
  await lifecycleDependencies.acquireSingleInstanceLock(
    lifecycleDependencies.BOT_TOKEN
  );
  const instanceLockMs: number = elapsedMsSince(lockStartedAtNs);

  let phases: ColdStartPhaseTimings;
  let recovered: ColdStartRecovered;
  try {
    const cleanupStartedAtNs: number = Bun.nanoseconds();
    await lifecycleDependencies.cleanupOrphanedTempFiles();
    const orphanCleanupMs: number = elapsedMsSince(cleanupStartedAtNs);

    const stateStartedAtNs: number = Bun.nanoseconds();
    await lifecycleDependencies.loadState();
    const stateLoadMs: number = elapsedMsSince(stateStartedAtNs);

    const inputStartedAtNs: number = Bun.nanoseconds();
    lifecycleDependencies.validateExistingDeploymentInputs();
    const deploymentInputMs: number = elapsedMsSince(inputStartedAtNs);

    const diskIOStartedAtNs: number = Bun.nanoseconds();
    lifecycleDependencies.initDiskIO();
    const diskIOInitMs: number = elapsedMsSince(diskIOStartedAtNs);

    const loadStartedAtNs: number = Bun.nanoseconds();
    const loaded: LoadedData = await lifecycleDependencies.loadPersistedData();
    const persistedLoadMs: number = elapsedMsSince(loadStartedAtNs);

    const hydrateStartedAtNs: number = Bun.nanoseconds();
    lifecycleDependencies.hydrateChatStateCache(loaded.chatStates);
    lifecycleDependencies.hydrateIdentityStorageCounts(
      loaded.whitelistEntryCount,
      loaded.blocklistEntryCount
    );
    const hydrateMs: number = elapsedMsSince(hydrateStartedAtNs);

    phases = {
      moduleGraphMs,
      instanceLockMs,
      orphanCleanupMs,
      stateLoadMs,
      deploymentInputMs,
      diskIOInitMs,
      persistedLoadMs,
      hydrateMs,
      readyMs: Bun.nanoseconds() / 1_000_000,
    };
    recovered = {
      aiMemoryChats: loaded.aiMemories.size,
      chatStates: loaded.chatStates.size,
      whitelistEntries: loaded.whitelistEntryCount,
      blocklistEntries: loaded.blocklistEntryCount,
      pendingRemovals: loaded.pendingBlockedRemovals.size,
    };
  } finally {
    await lifecycleDependencies.terminateDiskIO();
    await lifecycleDependencies.releaseSingleInstanceLock(
      lifecycleDependencies.BOT_TOKEN
    );
  }

  return {
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    phases,
    recovered,
    io: diffProcessIo(io, readProcessIo()),
    peakRssBytes: Math.max(
      process.memoryUsage().rss,
      process.resourceUsage().maxRSS * 1_024
    ),
  };
}

/** `--child cold-start` 的入口；结果按 JSON 打到 stdout。 */
export async function main(): Promise<void> {
  const round: ColdStartRound = await runColdStartChild();
  process.stdout.write(`${JSON.stringify(round)}\n`);
}
