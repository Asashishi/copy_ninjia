/**
 * fixture 播种子进程：把一轮要用的 mock 运行时数据根写成生产格式。
 *
 * 单独一个进程而不是在测量进程里顺手写完，是冷启动那一段的前提：同一个进程
 * 里播完种再「冷启动」，SQLite 页缓存、Bun 语句缓存、JSC 的类型反馈和整张
 * 模块图都已经是热的，量到的不是冷启动。
 */

import { installOutboundGuards } from "../outboundGuard";
import {
  COLD_START_AI_MEMORY_CHATS,
  COLD_START_JOIN_LOG_EVENTS,
} from "./constants";
import {
  benchmarkChatId,
  buildAiMemorySnapshot,
  createBenchmarkDatabase,
  createEmptyBenchmarkDatabase,
  fixtureCounts,
  joinLogEvent,
} from "./fixture";
import { assertBenchmarkRuntimeRoot } from "./mockRoot";
import { validateExistingDeploymentInputs } from
  "../../../packages/config/readiness";
import { BOT_TOKEN } from "../../../packages/config/telegram";
import { RUNTIME_DATA_ROOT } from "../../../packages/consts/paths";
import {
  acquireSingleInstanceLock,
  releaseSingleInstanceLock,
} from "../../../packages/infra/storage/instanceLock";
import {
  flushDiskIO,
  initDiskIO,
  loadPersistedData,
  postDiskIO,
  terminateDiskIO,
} from "../../../packages/infra/diskIO";
import {
  persistGlobalState,
  seedMissingAssetState,
} from "../../../packages/infra/storage/stateStore";
import type { SeededFixtureCounts } from "./fixture";

/** 播种模式：冷启动要满库，链路测量要空库。 */
type SeedMode = "cold-start" | "chain";

/** 链路模式回传的空计数；空库本身就是它要的初始条件。 */
const EMPTY_COUNTS: SeededFixtureCounts = {
  whitelistEntries: 0,
  blocklistEntries: 0,
  chatStates: 0,
  chatQaEntries: 0,
  pendingRemovals: 0,
  aiMemoryChats: 0,
  joinLogEvents: 0,
};

function parseSeedMode(value: string | undefined): SeedMode {
  if (value === "cold-start" || value === "chain") return value;
  throw new Error("Seed child mode must be cold-start or chain.");
}

async function seedWorkerOwnedFiles(mode: SeedMode): Promise<void> {
  await loadPersistedData();
  // state.json 也要真的存在：冷启动那一段量的是「读到一份完整部署数据」的成本，
  // 缺文件时 loadState 只是一次 ENOENT 早退，与生产走的不是同一条路。
  seedMissingAssetState();
  await persistGlobalState("performance benchmark fixture");
  if (mode === "chain") return;
  for (let index: number = 0; index < COLD_START_AI_MEMORY_CHATS; index += 1) {
    if (!postDiskIO({
      type: "aiMemory",
      chatId: benchmarkChatId(index),
      revision: 1,
      snapshot: buildAiMemorySnapshot(index),
    })) {
      throw new Error(
        `Fixture AI memory snapshot ${index} was rejected by the persistence Worker.`
      );
    }
  }
  for (let index: number = 0; index < COLD_START_JOIN_LOG_EVENTS; index += 1) {
    if (!postDiskIO(joinLogEvent(index))) {
      throw new Error(
        `Fixture join-log event ${index} was rejected by the persistence Worker.`
      );
    }
  }
  if (await flushDiskIO() !== "flushed") {
    throw new Error("Fixture flush did not reach every persistence domain.");
  }
}

/** 把 fixture 写进本进程的运行时数据根；数据根不是本基准建的就直接拒绝。 */
async function runSeedChild(mode: SeedMode): Promise<SeededFixtureCounts> {
  assertBenchmarkRuntimeRoot(RUNTIME_DATA_ROOT);
  installOutboundGuards();
  // 先取实例锁，顺序与生产启动一致。这一步不只是仪式：数据根预检会按生产口径
  // 建出 logs/、memory/、database/ 并钉住权限，跳过它的话这三个目录会由落盘
  // Worker 用默认 umask 建成 0755，随后真正的冷启动会因为「目录比 0750 宽」
  // 拒绝启动——那是一次 fixture 造错了，不是被测代码的问题。
  await acquireSingleInstanceLock(BOT_TOKEN);
  try {
    if (mode === "chain") createEmptyBenchmarkDatabase();
    else createBenchmarkDatabase();
    // 与生产启动同序（见 coldStart.ts 的分段计时）：部署输入预检必须先于 Disk I/O
    // 完成。贴纸配置快照由它填进本线程 holder，loadPersistedData 组装 load 请求时
    // 要同步取用；缺了它 getStickerConfig 会按「预检未完成」当场拒绝。
    await validateExistingDeploymentInputs();
    initDiskIO();
    try {
      await seedWorkerOwnedFiles(mode);
    } finally {
      await terminateDiskIO();
    }
  } finally {
    await releaseSingleInstanceLock(BOT_TOKEN);
  }
  return mode === "chain" ? EMPTY_COUNTS : fixtureCounts();
}

/** `--child seed <mode>` 的入口；结果按 JSON 打到 stdout。 */
export async function main(argument: string | undefined): Promise<void> {
  const counts: SeededFixtureCounts = await runSeedChild(parseSeedMode(argument));
  await Bun.write(Bun.stdout, `${JSON.stringify(counts)}\n`);
}
