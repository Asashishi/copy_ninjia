/**
 * 完整流程 child runner：唯一加载生产实现的链路模块。
 * storageChains 与 commandChains 只接收这里装配的生产入口，不加载生产模块图。
 */

import {
  installCannedTelegramOutbound,
  installOutboundGuards,
  cannedTelegramCalls,
  cannedTelegramCallTimes,
} from "../outboundGuard";
import {
  AD_DETECT_DRAIN_BUDGET_MS,
  AI_REPLY_SETTLE_ATTEMPTS,
  AI_REPLY_WARMUP_OPERATIONS,
  BOT_PERMISSION_WAIT_ATTEMPTS,
  BOT_PERMISSION_WAIT_STEP_MS,
  CHAIN_AD_DETECT_COMMANDS,
  CHAIN_AI_MEMORY_SNAPSHOTS,
  CHAIN_AI_REPLY_COMMANDS,
  CHAIN_CHAT_QA_WRITES,
  CHAIN_CHAT_STATE_WRITES,
  CHAIN_IDENTITY_BATCHES,
  CHAIN_JOIN_LOG_EVENTS,
  CHAIN_LOG_ENTRIES,
  CHAIN_TEMPORARY_WHITELIST_WRITES,
  CHAIN_WARMUP_OPERATIONS,
} from "./constants";
import {
  benchmarkChatId,
  benchmarkUserId,
  buildAiMemorySnapshot,
} from "./fixture";
import { assertBenchmarkRuntimeRoot } from "./mockRoot";
import { percentile } from "../statistics";
import { diffProcessIo, readProcessIo } from "./processIo";
import { createStorageChain } from "./storageChains";
import { createCommandChain } from "./commandChains";
import { MAIN_WRITE_THROUGH_WORKING_SET } from
  "../identityDatabase/constants";
import { WHITE_ENTRY } from "../identityDatabase/fixtures";
import {
  blocklistEntryCache,
  whitelistEntryCache,
} from "../../../packages/cache/main/identityStorage";
import {
  temporaryWhitelistActivityCache,
  unacknowledgedTemporaryWhitelistWrites,
} from "../../../packages/cache/main/temporaryWhitelist";
import { IDENTITY_WRITE_BATCH_MAX_ENTRIES } from
  "../../../packages/consts/identityStorage";
import { STATE_MANAGED_CHAT_LIMIT } from
  "../../../packages/consts/storage";
import { RUNTIME_DATA_ROOT } from "../../../packages/consts/paths";
import {
  flushDiskIO,
  flushDiskIODomain,
  initDiskIO,
  loadPersistedData,
  postDiskIO,
  readIdentityPolicies,
  relayLogMessage,
  terminateDiskIO,
} from "../../../packages/infra/diskIO";
import {
  hydrateIdentityStorageCounts,
  queueIdentityPolicyWrite,
} from "../../../packages/infra/identityStorage";
import { persistChatState } from
  "../../../packages/infra/chatStateStorage";
import { setChatQa } from "../../../packages/infra/qaStore";
import { recordJoinLog } from "../../../packages/infra/joinLog";
import { getOrCreateChatState } from
  "../../../packages/infra/storage/stateStore";
import { recordEligibleTemporaryWhitelistActivity } from
  "../../../packages/antiRaid/temporaryWhitelist";
import { drainAdDisposals, handleAdDetected } from
  "../../../packages/antiRaid/adDetect";
import { ensureBotChatPermissions } from
  "../../../packages/infra/botAdmin";
import {
  ensureAdDetectAgentConfig,
  ensureAgentDeploymentConfig,
} from "../../../packages/config/agent";
import { validateExistingDeploymentInputs } from
  "../../../packages/config/readiness";
import { cacheAdminIds } from
  "../../../packages/cache/workers/antiRaid/admins";
import { adDetectOpenAiClientHolder } from
  "../../../packages/cache/workers/antiRaid/openai";
import { adDetectPublishHolder } from
  "../../../packages/cache/workers/antiRaid/adDetect";
import { enqueueAdCandidate, runAdDetectBatch } from
  "../../../packages/workers/antiRaid/adDetect/queue";
import { geminiClientCache } from
  "../../../packages/cache/workers/aiChat/gemini";
import { botInfoState } from
  "../../../packages/cache/workers/aiChat/identity";
import { replyGenerationTasks } from
  "../../../packages/cache/workers/aiChat/replies";
import { recordChatMessage } from
  "../../../packages/workers/aiChat/rollingMemory";
import { generateAndSendReply } from
  "../../../packages/workers/aiChat/replyPipeline";
import type { ChainDefinition } from "./chainDefinition";
import type { CommandChainDependencies } from "./commandChains";
import type { ProcessIoSnapshot } from "./processIo";
import type { StorageChainDependencies } from "./storageChains";
import type { ChainName, ChainRound } from "./types";

const STORAGE_CHAIN_DEPENDENCIES: StorageChainDependencies = {
  chainJoinLogEvents: CHAIN_JOIN_LOG_EVENTS,
  chainIdentityBatches: CHAIN_IDENTITY_BATCHES,
  chainTemporaryWhitelistWrites: CHAIN_TEMPORARY_WHITELIST_WRITES,
  chainChatStateWrites: CHAIN_CHAT_STATE_WRITES,
  chainChatQaWrites: CHAIN_CHAT_QA_WRITES,
  chainAiMemorySnapshots: CHAIN_AI_MEMORY_SNAPSHOTS,
  chainLogEntries: CHAIN_LOG_ENTRIES,
  chainWarmupOperations: CHAIN_WARMUP_OPERATIONS,
  identityWriteBatchMaxEntries: IDENTITY_WRITE_BATCH_MAX_ENTRIES,
  mainWriteThroughWorkingSet: MAIN_WRITE_THROUGH_WORKING_SET,
  stateManagedChatLimit: STATE_MANAGED_CHAT_LIMIT,
  whiteEntry: WHITE_ENTRY,
  benchmarkChatId,
  benchmarkUserId,
  buildAiMemorySnapshot,
  recordJoinLog,
  hydrateIdentityStorageCounts,
  queueIdentityPolicyWrite,
  persistChatState,
  setChatQa,
  getOrCreateChatState,
  postDiskIO,
  relayLogMessage,
  flushDiskIO,
  flushDiskIODomain,
  readIdentityPolicies,
  recordEligibleTemporaryWhitelistActivity,
  ensureAdDetectAgentConfig,
  whitelistEntryCache,
  blocklistEntryCache,
  temporaryWhitelistActivityCache,
  unacknowledgedTemporaryWhitelistWrites,
};

const COMMAND_CHAIN_DEPENDENCIES: CommandChainDependencies = {
  chainAdDetectCommands: CHAIN_AD_DETECT_COMMANDS,
  chainAiReplyCommands: CHAIN_AI_REPLY_COMMANDS,
  aiReplyWarmupOperations: AI_REPLY_WARMUP_OPERATIONS,
  aiReplySettleAttempts: AI_REPLY_SETTLE_ATTEMPTS,
  adDetectDrainBudgetMs: AD_DETECT_DRAIN_BUDGET_MS,
  botPermissionWaitAttempts: BOT_PERMISSION_WAIT_ATTEMPTS,
  botPermissionWaitStepMs: BOT_PERMISSION_WAIT_STEP_MS,
  stateManagedChatLimit: STATE_MANAGED_CHAT_LIMIT,
  benchmarkChatId,
  benchmarkUserId,
  ensureAdDetectAgentConfig,
  ensureAgentDeploymentConfig,
  handleAdDetected,
  drainAdDisposals,
  ensureBotChatPermissions,
  getOrCreateChatState,
  cacheAdminIds,
  enqueueAdCandidate,
  runAdDetectBatch,
  adDetectOpenAiClientHolder,
  adDetectPublishHolder,
  cannedTelegramCalls,
  cannedTelegramCallTimes,
  geminiClientCache,
  botInfoState,
  replyGenerationTasks,
  recordChatMessage,
  generateAndSendReply,
};

const COMMAND_CHAINS: ReadonlySet<ChainName> = new Set<ChainName>([
  "ad-detect-command",
  "ai-reply-command",
]);

function createChain(chain: ChainName): ChainDefinition {
  const storage: ChainDefinition | undefined = createStorageChain(
    chain,
    STORAGE_CHAIN_DEPENDENCIES
  );
  if (storage !== undefined) return storage;
  const command: ChainDefinition | undefined = createCommandChain(
    chain,
    COMMAND_CHAIN_DEPENDENCIES
  );
  if (command !== undefined) return command;
  throw new Error(`Chain ${chain} has no definition.`);
}

function parseChainName(value: string | undefined): ChainName {
  switch (value) {
    case "join-log-append":
    case "identity-policy-write":
    case "temporary-whitelist-write":
    case "chat-state-write":
    case "chat-qa-write":
    case "ai-memory-snapshot":
    case "diagnostic-log":
    case "ad-detect-command":
    case "ai-reply-command": return value;
    default:
      throw new Error(
        "Chain child expects one declared storage or command chain name."
      );
  }
}

async function measureChain(definition: ChainDefinition): Promise<ChainRound> {
  await definition.prepare?.();
  const warmups: number =
    definition.warmupOperations ?? CHAIN_WARMUP_OPERATIONS;
  for (let index: number = 0; index < warmups; index += 1) {
    await definition.run(index);
  }
  const ioBefore: ProcessIoSnapshot = readProcessIo();
  const latenciesMs: number[] = new Array<number>(definition.operations);
  let peakRssBytes: number = process.memoryUsage().rss;
  let excludedTotalNs: number = 0;
  const startedAtNs: number = Bun.nanoseconds();
  for (let index: number = 0; index < definition.operations; index += 1) {
    const operationStartedAtNs: number = Bun.nanoseconds();
    await definition.run(warmups + index);
    const operationNs: number = Bun.nanoseconds() - operationStartedAtNs;
    const excludedNs: number = Math.min(
      Math.max(definition.excludedNanoseconds?.() ?? 0, 0),
      operationNs
    );
    excludedTotalNs += excludedNs;
    latenciesMs[index] = (operationNs - excludedNs) / 1_000_000;
  }
  const elapsedMs: number =
    (Bun.nanoseconds() - startedAtNs - excludedTotalNs) / 1_000_000;
  const io: ProcessIoSnapshot = readProcessIo();
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  await definition.verify?.();
  const sorted: number[] = [...latenciesMs].sort(
    (left: number, right: number): number => left - right
  );
  let latencySum: number = 0;
  for (const latency of latenciesMs) latencySum += latency;
  const records: number =
    definition.operations * definition.recordsPerOperation;
  return {
    chain: definition.chain,
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    operations: definition.operations,
    recordsPerOperation: definition.recordsPerOperation,
    elapsedMs,
    operationThroughputPerSecond: definition.operations * 1_000 / elapsedMs,
    throughputPerSecond: records * 1_000 / elapsedMs,
    meanLatencyMs: latencySum / definition.operations,
    p50LatencyMs: percentile(sorted, 50),
    p95LatencyMs: percentile(sorted, 95),
    maxLatencyMs: sorted[sorted.length - 1]!,
    io: diffProcessIo(ioBefore, io),
    peakRssBytes: Math.max(
      peakRssBytes,
      process.resourceUsage().maxRSS * 1_024
    ),
    checksum: records,
  };
}

function routeBusinessLogsToStderr(): void {
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
}

async function runChainChild(chain: ChainName): Promise<ChainRound> {
  assertBenchmarkRuntimeRoot(RUNTIME_DATA_ROOT);
  routeBusinessLogsToStderr();
  installOutboundGuards();
  if (COMMAND_CHAINS.has(chain)) installCannedTelegramOutbound();
  // 与生产启动同序：部署输入预检填充贴纸等配置快照与三份功能 readiness。
  // loadPersistedData 要取贴纸包，广告检测链路要读 adDetectConfigReadiness()，
  // 两者都在这一步之后才有值。
  await validateExistingDeploymentInputs();
  initDiskIO();
  try {
    await loadPersistedData();
    return await measureChain(createChain(chain));
  } finally {
    await terminateDiskIO();
  }
}

/** --child chain 的严格入口；结果按 JSON 写入 stdout 协议通道。 */
export async function main(argument: string | undefined): Promise<void> {
  const round: ChainRound = await runChainChild(parseChainName(argument));
  await Bun.write(Bun.stdout, `${JSON.stringify(round)}\n`);
}
