/**
 * 冷启动子进程：按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时。
 *
 * 本文件不得静态 import `packages/` 下的模块（`import type` 除外）：模块图加载是
 * 被测的第一段，由 `runColdStartChild` 动态 import。
 *
 * 覆盖范围：只跑到「持久化恢复就绪」，不含 `bot.init()`、命令菜单注册、黑名单补扫
 * 这些需要联网的握手，也不含 AI 与 Anti-Raid 业务 Worker 的创建（创建要等
 * `bot.botInfo`）。
 */

import { assertBenchmarkRuntimeRoot } from "./mockRoot";
import {
  diffProcessIo,
  readProcessIo,
} from "./processIo";
import type { ProcessIoSnapshot } from "./processIo";
// 只导类型：`import type` 在运行期被擦除，不加载生产模块图。
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
 * 各段之间不插入 GC、不清空缓存，与生产启动连续执行的方式一致。
 */
async function runColdStartChild(): Promise<ColdStartRound> {
  const io: ProcessIoSnapshot = readProcessIo();

  const moduleStartedAtNs: number = Bun.nanoseconds();
  const lifecycleDependencies: ApplicationLifecycleDependencies = (
    await import("../../../packages/app/lifecycleDependencies")
  ).lifecycleDependencies;
  const moduleGraphMs: number = elapsedMsSince(moduleStartedAtNs);

  // 模块图加载完成后立即安装出站拦截：下面各段只碰本地文件。
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
    await lifecycleDependencies.validateExistingDeploymentInputs();
    const deploymentInputMs: number = elapsedMsSince(inputStartedAtNs);

    const diskIOStartedAtNs: number = Bun.nanoseconds();
    lifecycleDependencies.initDiskIO();
    const diskIOInitMs: number = elapsedMsSince(diskIOStartedAtNs);

    const loadStartedAtNs: number = Bun.nanoseconds();
    const loaded: LoadedData = await lifecycleDependencies.loadPersistedData();
    const persistedLoadMs: number = elapsedMsSince(loadStartedAtNs);

    const hydrateStartedAtNs: number = Bun.nanoseconds();
    lifecycleDependencies.hydrateChatStateCache(loaded.chatStates);
    lifecycleDependencies.hydrateChatQaCache(loaded.chatQa);
    lifecycleDependencies.hydrateIdentityStorageCounts(
      loaded.permissionEntryCount,
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
    let chatQaEntries: number = 0;
    for (const questions of loaded.chatQa.values()) {
      chatQaEntries += questions.size;
    }
    recovered = {
      aiMemoryChats: loaded.aiMemories.size,
      chatStates: loaded.chatStates.size,
      chatQaEntries,
      permissionList: loaded.permissionEntryCount,
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
  await Bun.write(Bun.stdout, `${JSON.stringify(round)}\n`);
}
