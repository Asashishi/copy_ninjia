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
import type { StoredTemporaryWhitelistActivity } from
  "../../packages/types/temporaryWhitelist";
import type { AdDetectionMessageContext } from
  "../../packages/types/antiRaid/adDetect";

describe("全量性能链路编排", () => {
  test("临时白名单 CPU 与 durable 场景分别登记且不重名", () => {
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
    const rows: StoredTemporaryWhitelistActivity[] = [];
    let readinessCalls: number = 0;
    const dependencies: StorageChainDependencies = {
      chainWarmupOperations: 0,
      chainTemporaryWhitelistWrites: 1,
      benchmarkChatId: (index: number): number => -1_000 - index,
      benchmarkUserId: (index: number): number => 10_000 + index,
      ensureAdDetectAgentConfig: (): never => {
        readinessCalls++;
        return undefined as never;
      },
      hydrateIdentityStorageCounts: (): void => {},
      whitelistEntryCache: whitelist as never,
      blocklistEntryCache: blocklist as never,
      temporaryWhitelistActivityCache: temporary as never,
      unacknowledgedTemporaryWhitelistWrites: unacknowledged as never,
      recordEligibleTemporaryWhitelistActivity: ({
        message,
      }: AdDetectionMessageContext): boolean => {
        expect(message.text).toBe("性能基准普通群发言");
        const id: number = message.from!.id;
        unacknowledged.add(id);
        rows.push({
          id,
          tempWhite: false,
          tempWhiteAt: null,
          tempWhiteCount: 0,
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
        readonly temporaryWhitelist: readonly StoredTemporaryWhitelistActivity[];
      }> => ({ whitelist: [], blocklist: [], temporaryWhitelist: rows }),
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
