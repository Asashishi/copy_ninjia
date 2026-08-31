import type { Message } from "@grammyjs/types";
import type { ChatState } from "../../../packages/types/chatState";
import type { WhitelistEntryData } from
  "../../../packages/types/identityPolicy";
import type { IdentityPolicyRawReadResult } from
  "../../../packages/types/identityStorage";
import type { buildAiMemorySnapshot } from "./fixture";
import type { recordJoinLog } from "../../../packages/infra/joinLog";
import type {
  hydrateIdentityStorageCounts,
  queueIdentityPolicyWrite,
} from "../../../packages/infra/identityStorage";
import type { persistChatState } from
  "../../../packages/infra/chatStateStorage";
import type { setChatQa } from "../../../packages/infra/qaStore";
import type { getOrCreateChatState } from
  "../../../packages/infra/storage/stateStore";
import type {
  flushDiskIO,
  flushDiskIODomain,
  postDiskIO,
  readIdentityPolicies,
  relayLogMessage,
} from "../../../packages/infra/diskIO";
import type { recordEligibleTemporaryWhitelistActivity } from
  "../../../packages/antiRaid/temporaryWhitelist";
import type { ensureAdDetectAgentConfig } from
  "../../../packages/config/agent";
import type {
  blocklistEntryCache,
  whitelistEntryCache,
} from "../../../packages/cache/main/identityStorage";
import type {
  temporaryWhitelistActivityCache,
  unacknowledgedTemporaryWhitelistWrites,
} from "../../../packages/cache/main/temporaryWhitelist";
import type { ChainDefinition } from "./chainDefinition";
import type { ChainName } from "./types";

export interface StorageChainDependencies {
  readonly chainJoinLogEvents: number;
  readonly chainIdentityBatches: number;
  readonly chainTemporaryWhitelistWrites: number;
  readonly chainChatStateWrites: number;
  readonly chainChatQaWrites: number;
  readonly chainAiMemorySnapshots: number;
  readonly chainLogEntries: number;
  readonly chainWarmupOperations: number;
  readonly identityWriteBatchMaxEntries: number;
  readonly mainWriteThroughWorkingSet: number;
  readonly stateManagedChatLimit: number;
  readonly whiteEntry: Readonly<WhitelistEntryData>;
  readonly benchmarkChatId: (index: number) => number;
  readonly benchmarkUserId: (index: number) => number;
  readonly buildAiMemorySnapshot: typeof buildAiMemorySnapshot;
  readonly recordJoinLog: typeof recordJoinLog;
  readonly hydrateIdentityStorageCounts: typeof hydrateIdentityStorageCounts;
  readonly queueIdentityPolicyWrite: typeof queueIdentityPolicyWrite;
  readonly persistChatState: typeof persistChatState;
  readonly setChatQa: typeof setChatQa;
  readonly getOrCreateChatState: typeof getOrCreateChatState;
  readonly postDiskIO: typeof postDiskIO;
  readonly relayLogMessage: typeof relayLogMessage;
  readonly flushDiskIO: typeof flushDiskIO;
  readonly flushDiskIODomain: typeof flushDiskIODomain;
  readonly readIdentityPolicies: typeof readIdentityPolicies;
  readonly recordEligibleTemporaryWhitelistActivity:
    typeof recordEligibleTemporaryWhitelistActivity;
  readonly ensureAdDetectAgentConfig: typeof ensureAdDetectAgentConfig;
  readonly whitelistEntryCache: Pick<typeof whitelistEntryCache, "set">;
  readonly blocklistEntryCache: Pick<typeof blocklistEntryCache, "set">;
  readonly temporaryWhitelistActivityCache:
  Pick<typeof temporaryWhitelistActivityCache, "set">;
  readonly unacknowledgedTemporaryWhitelistWrites:
  Pick<typeof unacknowledgedTemporaryWhitelistWrites, "has">;
}

function chatIdForSequence(
  sequence: number,
  dependencies: StorageChainDependencies
): number {
  return dependencies.benchmarkChatId(
    sequence % dependencies.stateManagedChatLimit
  );
}

function joinLogChain(
  dependencies: StorageChainDependencies
): ChainDefinition {
  return {
    chain: "join-log-append",
    operations: dependencies.chainJoinLogEvents,
    recordsPerOperation: 1,
    run: async (sequence: number): Promise<void> => {
      if (!await dependencies.recordJoinLog({
        chatId: dependencies.benchmarkChatId(
          sequence % dependencies.stateManagedChatLimit
        ),
        userId: dependencies.benchmarkUserId(sequence),
        joinedAt: Date.now(),
      })) {
        throw new Error(`Join-log event ${sequence} did not reach the disk.`);
      }
    },
  };
}

function identityPolicyChain(
  dependencies: StorageChainDependencies
): ChainDefinition {
  return {
    chain: "identity-policy-write",
    operations: dependencies.chainIdentityBatches,
    recordsPerOperation: dependencies.identityWriteBatchMaxEntries,
    prepare: (): void => {
      dependencies.hydrateIdentityStorageCounts(0, 0);
      for (
        let id: number = 1;
        id <= dependencies.mainWriteThroughWorkingSet;
        id += 1
      ) {
        dependencies.whitelistEntryCache.set(id, null);
        dependencies.blocklistEntryCache.set(id, null);
      }
    },
    run: async (sequence: number): Promise<void> => {
      const firstOperation: number =
        sequence * dependencies.identityWriteBatchMaxEntries;
      for (
        let offset: number = 0;
        offset < dependencies.identityWriteBatchMaxEntries;
        offset += 1
      ) {
        const operation: number = firstOperation + offset;
        const id: number =
          operation % dependencies.mainWriteThroughWorkingSet + 1;
        const cycle: number = Math.floor(
          operation / dependencies.mainWriteThroughWorkingSet
        );
        if (!dependencies.queueIdentityPolicyWrite(
          "whitelist",
          id,
          (cycle & 1) === 0 ? dependencies.whiteEntry : null
        )) {
          throw new Error(
            `Identity write ${operation} was rejected before reaching the Worker.`
          );
        }
      }
      if (await dependencies.flushDiskIODomain("whitelist") !== "flushed") {
        throw new Error(`Identity write batch ${sequence} was not committed.`);
      }
    },
  };
}

function temporaryWhitelistWriteChain(
  dependencies: StorageChainDependencies
): ChainDefinition {
  const chatId: number = dependencies.benchmarkChatId(0);
  const totalOperations: number = dependencies.chainWarmupOperations +
    dependencies.chainTemporaryWhitelistWrites;
  const chatState: Readonly<ChatState> = { isAdDetectEnabled: true };
  return {
    chain: "temporary-whitelist-write",
    operations: dependencies.chainTemporaryWhitelistWrites,
    recordsPerOperation: 1,
    prepare: async (): Promise<void> => {
      await dependencies.ensureAdDetectAgentConfig();
      dependencies.hydrateIdentityStorageCounts(0, 0);
      for (let sequence: number = 0; sequence < totalOperations; sequence += 1) {
        const id: number = dependencies.benchmarkUserId(sequence);
        dependencies.whitelistEntryCache.set(id, null);
        dependencies.blocklistEntryCache.set(id, null);
        dependencies.temporaryWhitelistActivityCache.set(id, null);
      }
    },
    run: async (sequence: number): Promise<void> => {
      const id: number = dependencies.benchmarkUserId(sequence);
      const message: Message = {
        message_id: sequence + 1,
        date: 1_800_000_000,
        chat: { id: chatId, type: "supergroup", title: "Performance fixture" },
        from: { id, is_bot: false, first_name: `Member${sequence}` },
        text: "性能基准普通群发言",
      };
      if (!dependencies.recordEligibleTemporaryWhitelistActivity({
        message,
        botId: 1,
        chatState,
        now: 1_800_000_000_000 + sequence,
      })) {
        throw new Error(
          `Temporary-whitelist activity ${sequence} was rejected before reaching the Worker.`
        );
      }
      if (
        await dependencies.flushDiskIODomain("temporaryWhitelist") !== "flushed"
      ) {
        throw new Error(
          `Temporary-whitelist activity ${sequence} was not committed.`
        );
      }
      if (dependencies.unacknowledgedTemporaryWhitelistWrites.has(id)) {
        throw new Error(
          `Temporary-whitelist activity ${sequence} did not receive its exact ACK.`
        );
      }
    },
    verify: async (): Promise<void> => {
      const ids: number[] = new Array<number>(totalOperations);
      for (let sequence: number = 0; sequence < totalOperations; sequence += 1) {
        ids[sequence] = dependencies.benchmarkUserId(sequence);
      }
      const reply: IdentityPolicyRawReadResult =
        await dependencies.readIdentityPolicies(ids);
      if (reply.temporaryWhitelist.length !== totalOperations) {
        throw new Error(
          `Temporary-whitelist chain persisted ${reply.temporaryWhitelist.length} of ${totalOperations} records.`
        );
      }
      for (const activity of reply.temporaryWhitelist) {
        if (
          activity.tempWhite ||
          activity.sendCount !== 1 ||
          activity.qualifiedAt !== null
        ) {
          throw new Error(
            `Temporary-whitelist chain persisted an unexpected activity for identity ${activity.id}.`
          );
        }
      }
    },
  };
}

function chatStateChain(
  dependencies: StorageChainDependencies
): ChainDefinition {
  return {
    chain: "chat-state-write",
    operations: dependencies.chainChatStateWrites,
    recordsPerOperation: 1,
    prepare: (): void => {
      for (
        let index: number = 0;
        index < dependencies.stateManagedChatLimit;
        index += 1
      ) {
        dependencies.getOrCreateChatState(dependencies.benchmarkChatId(index));
      }
    },
    run: async (sequence: number): Promise<void> => {
      const chatId: number = chatIdForSequence(sequence, dependencies);
      const state: ChatState = dependencies.getOrCreateChatState(chatId);
      state.isAntiRaidEnabled = (sequence & 1) === 0;
      state.title = `Performance fixture chat ${sequence}`;
      await dependencies.persistChatState(
        chatId,
        "performance benchmark chain"
      );
    },
  };
}

function chatQaChain(
  dependencies: StorageChainDependencies
): ChainDefinition {
  return {
    chain: "chat-qa-write",
    operations: dependencies.chainChatQaWrites,
    recordsPerOperation: 1,
    run: async (sequence: number): Promise<void> => {
      const chatId: number = chatIdForSequence(sequence, dependencies);
      dependencies.setChatQa(
        chatId,
        "性能基准问题",
        `性能基准答案 ${sequence}`
      );
      if (await dependencies.flushDiskIODomain("chatQa") !== "flushed") {
        throw new Error(`Chat Q&A write ${sequence} was not committed.`);
      }
    },
  };
}

function aiMemoryChain(
  dependencies: StorageChainDependencies
): ChainDefinition {
  return {
    chain: "ai-memory-snapshot",
    operations: dependencies.chainAiMemorySnapshots,
    recordsPerOperation: 1,
    run: async (sequence: number): Promise<void> => {
      const chatIndex: number = sequence % dependencies.stateManagedChatLimit;
      if (!dependencies.postDiskIO({
        type: "aiMemory",
        chatId: dependencies.benchmarkChatId(chatIndex),
        revision: sequence + 1,
        snapshot: dependencies.buildAiMemorySnapshot(chatIndex),
      })) {
        throw new Error(
          `AI memory snapshot ${sequence} was rejected before reaching the Worker.`
        );
      }
      if (await dependencies.flushDiskIODomain("aiMemory") !== "flushed") {
        throw new Error(`AI memory snapshot ${sequence} was not written.`);
      }
    },
  };
}

function diagnosticLogChain(
  dependencies: StorageChainDependencies
): ChainDefinition {
  return {
    chain: "diagnostic-log",
    operations: dependencies.chainLogEntries,
    recordsPerOperation: 1,
    run: async (sequence: number): Promise<void> => {
      if (!dependencies.relayLogMessage({
        timestamp: Date.now(),
        level: "error",
        args: [
          `Performance benchmark diagnostic ${sequence} for chat`,
          dependencies.benchmarkChatId(
            sequence % dependencies.stateManagedChatLimit
          ),
          dependencies.benchmarkUserId(sequence),
        ],
      })) {
        throw new Error(
          `Diagnostic log ${sequence} was refused by the bounded channel.`
        );
      }
      if (await dependencies.flushDiskIO() !== "flushed") {
        throw new Error(`Diagnostic log ${sequence} was not written.`);
      }
    },
  };
}

/** 返回存储链路定义；命令链路交给 commandChains。 */
export function createStorageChain(
  chain: ChainName,
  dependencies: StorageChainDependencies
): ChainDefinition | undefined {
  switch (chain) {
    case "join-log-append": return joinLogChain(dependencies);
    case "identity-policy-write": return identityPolicyChain(dependencies);
    case "temporary-whitelist-write":
      return temporaryWhitelistWriteChain(dependencies);
    case "chat-state-write": return chatStateChain(dependencies);
    case "chat-qa-write": return chatQaChain(dependencies);
    case "ai-memory-snapshot": return aiMemoryChain(dependencies);
    case "diagnostic-log": return diagnosticLogChain(dependencies);
    case "ad-detect-command":
    case "ai-reply-command": return undefined;
  }
}
