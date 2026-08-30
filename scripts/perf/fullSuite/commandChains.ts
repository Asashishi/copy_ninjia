import type { ChatState } from "../../../packages/types/chatState";
import type {
  ensureAdDetectAgentConfig,
  ensureAgentDeploymentConfig,
} from "../../../packages/config/agent";
import type {
  drainAdDisposals,
  handleAdDetected,
} from "../../../packages/antiRaid/adDetect";
import type { ensureBotChatPermissions } from
  "../../../packages/infra/botAdmin";
import type { getOrCreateChatState } from
  "../../../packages/infra/storage/stateStore";
import type { cacheAdminIds } from
  "../../../packages/cache/workers/antiRaid/admins";
import type {
  enqueueAdCandidate,
  runAdDetectBatch,
} from "../../../packages/workers/antiRaid/adDetect/queue";
import type { adDetectOpenAiClientHolder } from
  "../../../packages/cache/workers/antiRaid/openai";
import type { adDetectPublishHolder } from
  "../../../packages/cache/workers/antiRaid/adDetect";
import type {
  cannedTelegramCalls,
  cannedTelegramCallTimes,
} from "../outboundGuard";
import type { geminiClientCache } from
  "../../../packages/cache/workers/aiChat/gemini";
import type { botInfoState } from
  "../../../packages/cache/workers/aiChat/identity";
import type { replyGenerationTasks } from
  "../../../packages/cache/workers/aiChat/replies";
import type { recordChatMessage } from
  "../../../packages/workers/aiChat/rollingMemory";
import type { generateAndSendReply } from
  "../../../packages/workers/aiChat/replyPipeline";
import type { ChainDefinition } from "./chainDefinition";
import type { ChainName } from "./types";

export interface CommandChainDependencies {
  readonly chainAdDetectCommands: number;
  readonly chainAiReplyCommands: number;
  readonly aiReplyWarmupOperations: number;
  readonly aiReplySettleAttempts: number;
  readonly adDetectDrainBudgetMs: number;
  readonly botPermissionWaitAttempts: number;
  readonly botPermissionWaitStepMs: number;
  readonly stateManagedChatLimit: number;
  readonly benchmarkChatId: (index: number) => number;
  readonly benchmarkUserId: (index: number) => number;
  readonly ensureAdDetectAgentConfig: typeof ensureAdDetectAgentConfig;
  readonly ensureAgentDeploymentConfig: typeof ensureAgentDeploymentConfig;
  readonly handleAdDetected: typeof handleAdDetected;
  readonly drainAdDisposals: typeof drainAdDisposals;
  readonly ensureBotChatPermissions: typeof ensureBotChatPermissions;
  readonly getOrCreateChatState: typeof getOrCreateChatState;
  readonly cacheAdminIds: typeof cacheAdminIds;
  readonly enqueueAdCandidate: typeof enqueueAdCandidate;
  readonly runAdDetectBatch: typeof runAdDetectBatch;
  readonly adDetectOpenAiClientHolder: typeof adDetectOpenAiClientHolder;
  readonly adDetectPublishHolder: typeof adDetectPublishHolder;
  readonly cannedTelegramCalls: typeof cannedTelegramCalls;
  readonly cannedTelegramCallTimes: typeof cannedTelegramCallTimes;
  readonly geminiClientCache: typeof geminiClientCache;
  readonly botInfoState: typeof botInfoState;
  readonly replyGenerationTasks: typeof replyGenerationTasks;
  readonly recordChatMessage: typeof recordChatMessage;
  readonly generateAndSendReply: typeof generateAndSendReply;
}

const AI_REPLY_SEED_MESSAGES: number = 12;

function adDetectCommandChain(
  dependencies: CommandChainDependencies
): ChainDefinition {
  const chatId: number = dependencies.benchmarkChatId(0);
  return {
    chain: "ad-detect-command",
    operations: dependencies.chainAdDetectCommands,
    recordsPerOperation: 1,
    prepare: async (): Promise<void> => {
      dependencies.ensureAdDetectAgentConfig();
      dependencies.adDetectOpenAiClientHolder.current = {
        chat: {
          completions: {
            create: (): Promise<unknown> => Promise.resolve({
              choices: [{
                message: {
                  content: '{"ad":true,"reason":"performance benchmark"}',
                },
                finish_reason: "stop",
              }],
            }),
          },
        },
      } as never;
      dependencies.adDetectPublishHolder.current = dependencies.handleAdDetected;
      const state: ChatState = dependencies.getOrCreateChatState(chatId);
      state.isAdDetectEnabled = true;
      state.isInitEnabled = true;
      dependencies.ensureBotChatPermissions(chatId, Date.now());
      for (
        let attempt: number = 0;
        state.botPermissions === undefined &&
          attempt < dependencies.botPermissionWaitAttempts;
        attempt += 1
      ) {
        await Bun.sleep(dependencies.botPermissionWaitStepMs);
      }
      if (state.botPermissions?.isAdministrator !== true) {
        throw new Error(
          "Benchmark bot permissions never resolved to administrator."
        );
      }
      dependencies.cacheAdminIds(chatId, new Set<number>(), Date.now());
    },
    run: async (sequence: number): Promise<void> => {
      dependencies.enqueueAdCandidate({
        type: "adCandidate",
        chatId,
        senderId: dependencies.benchmarkUserId(sequence),
        messageId: sequence + 1,
        text: `性能基准广告文本 ${sequence}：加我微信 benchmark`,
        label: `Member${sequence}`,
        meta: { firstName: `Member${sequence}`, lastName: "", username: "" },
        isChannel: false,
        isForwarded: false,
        blocked: false,
        justJoined: true,
      }, Date.now());
      await dependencies.runAdDetectBatch(Date.now());
      if (
        await dependencies.drainAdDisposals(
          dependencies.adDetectDrainBudgetMs
        ) !== "flushed"
      ) {
        throw new Error(
          `Ad disposal ${sequence} did not settle within the drain budget.`
        );
      }
    },
  };
}

interface RecordBenchmarkMessageOptions {
  readonly chatId: number;
  readonly sequence: number;
  readonly messageId: number;
  readonly dependencies: CommandChainDependencies;
}

function recordBenchmarkMessage({
  chatId,
  sequence,
  messageId,
  dependencies,
}: RecordBenchmarkMessageOptions): void {
  dependencies.recordChatMessage({
    type: "record",
    chatId,
    senderId: dependencies.benchmarkUserId(sequence),
    firstName: `Member${sequence % 64}`,
    lastName: "",
    username: `member_${sequence % 64}`,
    messageId,
    replyTo: undefined,
    forwardedFrom: undefined,
    persistImmediately: false,
    text: `性能基准群聊上下文第 ${sequence} 条，用于把提示词撑到生产量级。`,
  });
}

async function settleReplyRound(
  sequence: number,
  dependencies: CommandChainDependencies
): Promise<void> {
  for (
    let attempt: number = 0;
    dependencies.replyGenerationTasks.size > 0 &&
      attempt < dependencies.aiReplySettleAttempts;
    attempt += 1
  ) {
    const tasks: Promise<void>[] = [];
    for (const generationTasks of dependencies.replyGenerationTasks.values()) {
      tasks.push(...generationTasks);
    }
    if (tasks.length === 0) break;
    await Promise.allSettled(tasks);
  }
  if (dependencies.replyGenerationTasks.size > 0) {
    throw new Error(`AI reply round ${sequence} never settled.`);
  }
}

function aiReplyCommandChain(
  dependencies: CommandChainDependencies
): ChainDefinition {
  const pauseNs: { current: number } = { current: 0 };
  return {
    chain: "ai-reply-command",
    operations: dependencies.chainAiReplyCommands,
    recordsPerOperation: 1,
    warmupOperations: dependencies.aiReplyWarmupOperations,
    excludedNanoseconds: (): number => pauseNs.current,
    prepare: (): void => {
      dependencies.ensureAgentDeploymentConfig();
      dependencies.botInfoState.current = {
        id: 1,
        username: "benchmark_bot",
        first_name: "benchmark",
      };
      dependencies.geminiClientCache.current = new Map([["text", {
        models: {
          generateContent: (): Promise<unknown> => Promise.resolve({
            candidates: [{
              finishReason: "STOP",
              content: { parts: [{ text: "性能基准回复。" }] },
            }],
            text: "性能基准回复。",
          }),
        },
      }]] as never);
      for (
        let index: number = 0;
        index < dependencies.stateManagedChatLimit;
        index += 1
      ) {
        const chatId: number = dependencies.benchmarkChatId(index);
        dependencies.getOrCreateChatState(chatId);
        for (
          let seed: number = 0;
          seed < AI_REPLY_SEED_MESSAGES;
          seed += 1
        ) {
          recordBenchmarkMessage({
            chatId,
            sequence: seed,
            messageId: seed + 1,
            dependencies,
          });
        }
      }
    },
    run: async (sequence: number): Promise<void> => {
      const chatId: number = dependencies.benchmarkChatId(
        sequence % dependencies.stateManagedChatLimit
      );
      const messageId: number = AI_REPLY_SEED_MESSAGES + sequence + 1;
      const sentBefore: number =
        dependencies.cannedTelegramCalls.get("sendMessage") ?? 0;
      recordBenchmarkMessage({ chatId, sequence, messageId, dependencies });
      dependencies.generateAndSendReply({
        chatId,
        triggerSenderId: dependencies.benchmarkUserId(sequence),
        replyToMessageId: messageId,
        imageGenerationRequested: false,
        isRandomTrigger: false,
        messageThreadId: undefined,
      });
      await settleReplyRound(sequence, dependencies);
      const typingAtNs: number =
        dependencies.cannedTelegramCallTimes.get("sendChatAction") ?? 0;
      const sentAtNs: number =
        dependencies.cannedTelegramCallTimes.get("sendMessage") ?? 0;
      const observedPauseNs: number = sentAtNs - typingAtNs;
      pauseNs.current = observedPauseNs > 0 ? observedPauseNs : 0;
      if (
        (dependencies.cannedTelegramCalls.get("sendMessage") ?? 0) <= sentBefore
      ) {
        throw new Error(`AI reply ${sequence} produced no outgoing message.`);
      }
    },
  };
}

/** 返回命令链路定义；存储链路交给 storageChains。 */
export function createCommandChain(
  chain: ChainName,
  dependencies: CommandChainDependencies
): ChainDefinition | undefined {
  switch (chain) {
    case "ad-detect-command": return adDetectCommandChain(dependencies);
    case "ai-reply-command": return aiReplyCommandChain(dependencies);
    case "join-log-append":
    case "identity-policy-write":
    case "temporary-whitelist-write":
    case "chat-state-write":
    case "chat-qa-write":
    case "ai-memory-snapshot":
    case "diagnostic-log": return undefined;
  }
}
