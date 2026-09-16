import { describe, expect, test } from "bun:test";
import { createStorageChain } from
  "../../scripts/perf/fullSuite/storageChains";
import {
  CHAIN_NAMES,
  PRODUCTION_HOT_PATH_SCENARIOS,
} from "../../scripts/perf/fullSuite/sections";
import type { StorageChainDependencies } from
  "../../scripts/perf/fullSuite/storageChains";
import type { ChainDefinition } from
  "../../scripts/perf/fullSuite/chainDefinition";
import type { StoredTemporaryAdBypassActivity } from
  "../../packages/types/temporaryAdBypass";
import type { AdDetectionMessageContext } from
  "../../packages/types/antiRaid/adDetect";
import type { ChatState } from "../../packages/types/chatState";
import type { DiskIOMessage } from "../../packages/types/diskIO";

describe("全量性能链路编排", () => {
  test("临时广告免检 CPU 与 durable 场景分别登记且不重名", () => {
    expect(PRODUCTION_HOT_PATH_SCENARIOS)
      .toContain("temporary-whitelist-activity");
    expect(CHAIN_NAMES).toContain("temporary-whitelist-write");
    expect(new Set(PRODUCTION_HOT_PATH_SCENARIOS).size)
      .toBe(PRODUCTION_HOT_PATH_SCENARIOS.length);
    expect(new Set(CHAIN_NAMES).size).toBe(CHAIN_NAMES.length);
  });

  test("durable 场景从资格入口等到精确 ACK，并核验最终记录数", async () => {
    const whitelist: Map<number, unknown> = new Map<number, unknown>();
    const blocklist: Map<number, unknown> = new Map<number, unknown>();
    const temporary: Map<number, unknown> = new Map<number, unknown>();
    const unacknowledged: Set<number> = new Set<number>();
    const rows: StoredTemporaryAdBypassActivity[] = [];
    let readinessCalls: number = 0;
    const dependencies: StorageChainDependencies = {
      chainWarmupOperations: 0,
      chainTemporaryAdBypassWrites: 1,
      benchmarkChatId: (index: number): number => -1_000 - index,
      benchmarkUserId: (index: number): number => 10_000 + index,
      ensureAdDetectAgentConfig: (): never => {
        readinessCalls++;
        return undefined as never;
      },
      hydrateIdentityStorageCounts: (): void => {},
      whitelistEntryCache: whitelist as never,
      blocklistEntryCache: blocklist as never,
      temporaryAdBypassActivityCache: temporary as never,
      unacknowledgedTemporaryAdBypassWrites: unacknowledged as never,
      recordEligibleTemporaryAdBypassActivity: ({
        message,
      }: AdDetectionMessageContext): boolean => {
        expect(message.text).toBe("性能基准普通群发言");
        const id: number = message.from!.id;
        unacknowledged.add(id);
        rows.push({
          id,
          adBypass: false,
          adBypassGrantedAt: null,
          qualifiedDays: 0,
          sendCount: 1,
          countedAt: 1_800_000_000_000,
          qualifiedAt: null,
        });
        return true;
      },
      flushDiskIODomain: async (): Promise<"flushed"> => {
        unacknowledged.clear();
        return "flushed";
      },
      readIdentityPolicies: async (): Promise<{
        readonly whitelist: readonly [];
        readonly blocklist: readonly [];
        readonly temporaryAdBypass: readonly StoredTemporaryAdBypassActivity[];
      }> => ({ whitelist: [], blocklist: [], temporaryAdBypass: rows }),
    } as unknown as StorageChainDependencies;
    const definition: ChainDefinition = createStorageChain(
      "temporary-whitelist-write",
      dependencies
    )!;

    await definition.prepare?.();
    await definition.run(0);
    await definition.verify?.();

    expect(readinessCalls).toBe(1);
    expect(whitelist.has(10_000)).toBeTrue();
    expect(blocklist.has(10_000)).toBeTrue();
    expect(temporary.has(10_000)).toBeTrue();
    expect(unacknowledged.size).toBe(0);
    expect(rows).toHaveLength(1);
  });
});

test.each(["complete", "missing", "stale"])("AI 快照链路先持久化群行，并拒绝未落盘或旧内容：%s", async (outcome: string): Promise<void> => {
  const states: Map<number, ChatState> = new Map<number, ChatState>();
  const durableStates: Set<number> = new Set<number>();
  const snapshots: Map<number, string> = new Map<number, string>();
  const writes: string[] = [];
  let pending: Readonly<{ chatId: number; snapshot: string }> | undefined;
  const dependencies: StorageChainDependencies = {
    stateManagedChatLimit: 2,
    chainWarmupOperations: 2,
    chainAiMemorySnapshots: 4,
    benchmarkChatId: (index: number): number => -1_000 - index,
    buildAiMemorySnapshot: (sequence: number): string => `snapshot-${sequence}`,
    getOrCreateChatState: (chatId: number): ChatState => {
      let state: ChatState | undefined = states.get(chatId);
      if (state === undefined) {
        state = {};
        states.set(chatId, state);
      }
      return state;
    },
    persistChatState: async (chatId: number): Promise<void> => {
      await Promise.resolve();
      expect(states.get(chatId)).toMatchObject({ isInitEnabled: true, isAIChatEnabled: true });
      durableStates.add(chatId);
    },
    postDiskIO: (message: DiskIOMessage): boolean => {
      if (message.type !== "aiMemory") throw new Error("Unexpected benchmark message");
      expect(durableStates.has(message.chatId)).toBeTrue();
      pending = { chatId: message.chatId, snapshot: message.snapshot };
      return true;
    },
    flushDiskIODomain: async (domain: string): Promise<"flushed"> => {
      expect(domain).toBe("aiMemory");
      if (pending === undefined) throw new Error("Missing pending write");
      snapshots.set(pending.chatId, pending.snapshot);
      writes.push(pending.snapshot);
      pending = undefined;
      return "flushed";
    },
    readBenchmarkAiMemories: (): ReadonlyMap<number, string> => snapshots,
  } as unknown as StorageChainDependencies;
  const definition: ChainDefinition = createStorageChain("ai-memory-snapshot", dependencies)!;
  await definition.prepare!();
  for (let sequence: number = 0; sequence < 6; sequence++) await definition.run(sequence);
  expect(writes).toEqual(["snapshot-0", "snapshot-1", "snapshot-2", "snapshot-3", "snapshot-4", "snapshot-5"]);
  if (outcome === "missing") snapshots.delete(-1_000);
  if (outcome === "stale") snapshots.set(-1_000, "snapshot-2");
  if (outcome === "complete") expect((): void => { definition.verify!(); }).not.toThrow();
  else expect((): void => { definition.verify!(); }).toThrow(outcome === "missing" ? "persisted 1 of 2" : "final snapshot");
});
