import { basename, dirname, resolve } from "node:path";
import {
  blocklistEntryCache,
  resetIdentityStorageCache,
  unacknowledgedWhitelistWrites,
  whitelistEntryCache,
} from "../../../packages/cache/main/identityStorage";
import {
  IDENTITY_WRITE_BATCH_MAX_ENTRIES,
} from "../../../packages/consts/identityStorage";
import { RUNTIME_DATA_ROOT } from "../../../packages/consts/paths";
import {
  flushDiskIODomain,
  initDiskIO,
  loadPersistedData,
  terminateDiskIO,
} from "../../../packages/infra/diskIO";
import {
  cachedBlocklistEntry,
  cachedWhitelistEntry,
  hydrateIdentityStorageCounts,
  queueIdentityPolicyWrite,
} from "../../../packages/infra/identityStorage";
import { ensureStickerConfig } from "../../../packages/config/stickers";
import type { LoadedData } from "../../../packages/types/diskIO";
import type { WhitelistEntryData } from
  "../../../packages/types/identityPolicy";
import type { FlushResult } from "../../../packages/types/lifecycle";
import {
  MAIN_BENCHMARK_ROOT_PREFIX,
  MAIN_LRU_READ_BATCH_COUNT,
  MAIN_WRITE_THROUGH_OPERATION_COUNT,
  MAIN_WRITE_THROUGH_WORKING_SET,
  READ_BATCH_SIZE,
  READ_FIXTURE_SIZE,
} from "./constants";
import { BLACK_ENTRY, WHITE_ENTRY } from "./fixtures";
import { measuredResult, measuredResultAsync } from "./measurement";
import { assertMockRoot } from "./roots";
import type { ChildResult } from "./types";

function seedMainLru(): void {
  resetIdentityStorageCache();
  for (let id: number = 1; id <= READ_FIXTURE_SIZE; id += 1) {
    if ((id & 1) === 0) {
      whitelistEntryCache.set(id, null);
      blocklistEntryCache.set(id, BLACK_ENTRY);
    } else {
      whitelistEntryCache.set(id, WHITE_ENTRY);
      blocklistEntryCache.set(id, null);
    }
  }
}

function runMainLruReadBatches(batches: number): number {
  let checksum: number = 0;
  let id: number = 1;
  for (let batch: number = 0; batch < batches; batch += 1) {
    for (let offset: number = 0; offset < READ_BATCH_SIZE; offset += 1) {
      if (cachedWhitelistEntry(id) !== undefined) checksum += 1;
      if (cachedBlocklistEntry(id) !== undefined) checksum += 1;
      id += 1;
      if (id > READ_FIXTURE_SIZE) id = 1;
    }
  }
  return checksum;
}

function seedMainWriteThroughCache(): void {
  for (let id: number = 1; id <= MAIN_WRITE_THROUGH_WORKING_SET; id += 1) {
    whitelistEntryCache.set(id, null);
    blocklistEntryCache.set(id, null);
  }
}

function runMainWriteThroughOperations(
  operations: number,
  startingOperation: number
): number {
  let checksum: number = 0;
  for (let offset: number = 0; offset < operations; offset += 1) {
    const operation: number = startingOperation + offset;
    const id: number = operation % MAIN_WRITE_THROUGH_WORKING_SET + 1;
    const cycle: number = Math.floor(operation / MAIN_WRITE_THROUGH_WORKING_SET);
    const value: Readonly<WhitelistEntryData> | null = (cycle & 1) === 0
      ? WHITE_ENTRY
      : null;
    if (!queueIdentityPolicyWrite("whitelist", id, value)) {
      throw new Error(`Main-thread write-through rejected operation ${operation}.`);
    }
    checksum += 1;
  }
  return checksum;
}

export function runMainLruReadChild(): ChildResult {
  try {
    seedMainLru();
    runMainLruReadBatches(50_000);
    const operations: number = MAIN_LRU_READ_BATCH_COUNT * READ_BATCH_SIZE;
    const result: ChildResult = measuredResult({
      operation: "main-lru-read",
      operations,
      batches: MAIN_LRU_READ_BATCH_COUNT,
      run: (): number => runMainLruReadBatches(MAIN_LRU_READ_BATCH_COUNT),
    });
    if (result.checksum !== operations) {
      throw new Error(`Main-thread LRU benchmark checksum mismatch: ${result.checksum}.`);
    }
    return result;
  } finally {
    resetIdentityStorageCache();
  }
}

async function flushMainWriteThrough(context: string): Promise<void> {
  const result: FlushResult = await flushDiskIODomain("whitelist", 120_000);
  if (result !== "flushed") {
    throw new Error(`${context} write-through flush ended as ${result}.`);
  }
  if (unacknowledgedWhitelistWrites.size !== 0) {
    throw new Error(
      `${context} left ${unacknowledgedWhitelistWrites.size} unacknowledged write(s).`
    );
  }
}

export async function runMainWriteThroughChild(
  mockRoot: string
): Promise<ChildResult> {
  assertMockRoot(mockRoot);
  if (
    dirname(RUNTIME_DATA_ROOT) !== resolve(mockRoot) ||
    !basename(RUNTIME_DATA_ROOT).startsWith(MAIN_BENCHMARK_ROOT_PREFIX)
  ) {
    throw new Error(
      "Main-thread write-through benchmark requires its isolated temporary root."
    );
  }
  // loadPersistedData 组装 load 请求时要同步取贴纸包，而 getStickerConfig 只读
  // 已预检的本线程快照。这里只补这一份、不走 validateExistingDeploymentInputs：
  // 本文件同时服务 `bun run perf:identity-database`，那条入口把 CONFIG_ROOT 指向
  // `config_example/`，整份预检会在 agent.json 的占位凭据上按设计拒绝。
  await ensureStickerConfig();
  initDiskIO();
  try {
    const loaded: LoadedData = await loadPersistedData(120_000);
    hydrateIdentityStorageCounts(
      loaded.whitelistEntryCount,
      loaded.blocklistEntryCount
    );
    seedMainWriteThroughCache();
    const warmupOperations: number = MAIN_WRITE_THROUGH_WORKING_SET * 2;
    const warmupChecksum: number = runMainWriteThroughOperations(
      warmupOperations,
      0
    );
    if (warmupChecksum !== warmupOperations) {
      throw new Error(
        `Main-thread write-through warmup checksum mismatch: ${warmupChecksum}.`
      );
    }
    await flushMainWriteThrough("Warmup");

    const result: ChildResult = await measuredResultAsync({
      operation: "main-write-through-acked",
      operations: MAIN_WRITE_THROUGH_OPERATION_COUNT,
      batches: MAIN_WRITE_THROUGH_OPERATION_COUNT /
        IDENTITY_WRITE_BATCH_MAX_ENTRIES,
      run: async (): Promise<number> => {
        const checksum: number = runMainWriteThroughOperations(
          MAIN_WRITE_THROUGH_OPERATION_COUNT,
          warmupOperations
        );
        await flushMainWriteThrough("Measured");
        return checksum;
      },
    });
    if (result.checksum !== MAIN_WRITE_THROUGH_OPERATION_COUNT) {
      throw new Error(
        `Main-thread write-through checksum mismatch: ${result.checksum}.`
      );
    }
    return result;
  } finally {
    await terminateDiskIO();
    resetIdentityStorageCache();
  }
}
