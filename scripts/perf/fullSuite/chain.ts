/**
 * 完整流程子进程：逐次量生产入口到该动作完成点的本地端到端耗时。
 *
 * 与热路径分区的分工要说清楚：那边量的是纯 CPU 叶子和编排主干，这里量的是
 * 五条落盘动作回答**一条业务事实真正写进硬盘要多久**，包含 Worker 消息往返、
 * SQLite 事务、追加写与 fsync；两条命令流程回答一次群消息在排除网络后需要多少
 * 本地处理。两组数的完成点由文档行名明确说明，不能互相换算。
 *
 * 每条链路各起一个子进程：同一个进程里连着跑，前一条链路留下的页缓存温度、
 * Worker 侧文件句柄和 JIT 反馈都会带进下一条，读数会系统性偏乐观。
 *
 * `ad-detect-command` 与 `ai-reply-command` 量的是**一条群消息走完用户可见流程**。
 * 前者覆盖入队、成串、管理员豁免、模型判定、删除与封禁、黑名单落盘、移除
 * outbox 落盘、处置排空；后者覆盖上下文记录、提示词构造、模型生成与消息发送，
 * 并扣除不占 CPU 的拟人停顿。模型与 Telegram 两处出站都由罐头就地应答，因此
 * 读数里没有网络往返，只有进程内工作与磁盘；这正是「除网络延迟外都要测」的
 * 口径。
 */

import {
  installCannedTelegramOutbound,
  installOutboundGuards,
} from "../outboundGuard";
import {
  CHAIN_AD_DETECT_COMMANDS,
  CHAIN_AI_MEMORY_SNAPSHOTS,
  CHAIN_AI_REPLY_COMMANDS,
  CHAIN_CHAT_STATE_WRITES,
  CHAIN_IDENTITY_BATCHES,
  CHAIN_JOIN_LOG_EVENTS,
  CHAIN_LOG_ENTRIES,
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
import { MAIN_WRITE_THROUGH_WORKING_SET } from "../identityDatabase/constants";
import { WHITE_ENTRY } from "../identityDatabase/fixtures";
import {
  blocklistEntryCache,
  whitelistEntryCache,
} from "../../../packages/cache/main/identityStorage";
import { IDENTITY_WRITE_BATCH_MAX_ENTRIES } from
  "../../../packages/consts/identityStorage";
import { STATE_MANAGED_CHAT_LIMIT } from "../../../packages/consts/storage";
import { RUNTIME_DATA_ROOT } from "../../../packages/consts/paths";
import {
  flushDiskIO,
  flushDiskIODomain,
  initDiskIO,
  loadPersistedData,
  postDiskIO,
  relayLogMessage,
  terminateDiskIO,
} from "../../../packages/infra/diskIO";
import { hydrateIdentityStorageCounts, queueIdentityPolicyWrite } from
  "../../../packages/infra/identityStorage";
import { persistChatState } from "../../../packages/infra/chatStateStorage";
import { recordJoinLog } from "../../../packages/infra/joinLog";
import { getOrCreateChatState } from
  "../../../packages/infra/storage/stateStore";
import {
  drainAdDisposals,
  handleAdDetected,
} from "../../../packages/antiRaid/adDetect";
import { ensureBotChatPermissions } from "../../../packages/infra/botAdmin";
import { ensureAdDetectAgentConfig } from "../../../packages/config/agent";
import { cacheAdminIds } from "../../../packages/cache/workers/antiRaid/admins";
import { adDetectOpenAiClientHolder } from
  "../../../packages/cache/workers/antiRaid/openai";
import { adDetectPublishHolder } from
  "../../../packages/cache/workers/antiRaid/adDetect";
import {
  enqueueAdCandidate,
  runAdDetectBatch,
} from "../../../packages/workers/antiRaid/adDetect/queue";
import {
  AD_DETECT_DRAIN_BUDGET_MS,
  AI_REPLY_SETTLE_ATTEMPTS,
  AI_REPLY_WARMUP_OPERATIONS,
  BOT_PERMISSION_WAIT_ATTEMPTS,
  BOT_PERMISSION_WAIT_STEP_MS,
} from "./constants";
import {
  cannedTelegramCalls,
  cannedTelegramCallTimes,
} from "../outboundGuard";
import { ensureAgentDeploymentConfig } from "../../../packages/config/agent";
import { geminiClientCache } from "../../../packages/cache/workers/aiChat/gemini";
import { botInfoState } from "../../../packages/cache/workers/aiChat/identity";
import { replyGenerationTasks } from
  "../../../packages/cache/workers/aiChat/replies";
import { recordChatMessage } from
  "../../../packages/workers/aiChat/rollingMemory";
import { generateAndSendReply } from
  "../../../packages/workers/aiChat/replyPipeline";
import type { ChatState } from "../../../packages/types/chatState";
import type { ProcessIoSnapshot } from "./processIo";
import type { ChainName, ChainRound } from "./types";

/** 一条链路的定义；`run` 必须在这一次 durable 完成后才返回。 */
interface ChainDefinition {
  readonly chain: ChainName;
  readonly operations: number;
  readonly recordsPerOperation: number;
  /**
   * 本条链路正式计时前的预热次数；缺省用 CHAIN_WARMUP_OPERATIONS。
   *
   * 只有把每次操作都拖到秒级的命令链路才该调小：那里预热一次的墙钟代价和正式
   * 计时一次一样贵，64 次预热会让这一条链路独占整轮基准的大半时间，而它的分位
   * 数在个位数次预热后就稳了。
   */
  readonly warmupOperations?: number;
  /** 正式计时前的一次性准备（灌缓存、建群状态等），不计时；允许异步。 */
  readonly prepare?: () => void | Promise<void>;
  readonly run: (sequence: number) => Promise<void>;
  /**
   * 本次操作里应当从读数中扣除的纳秒数；不实现表示整段都算。
   *
   * 只有一种东西该走这里：**刻意的等待**。AI 回复在发送前有一段拟人停顿（见
   * consts/aiChat/tools.ts 的 TYPING_DELAY_*），它是按群计的礼貌节奏，CPU 空转、
   * 不占任何容量——同一时刻别的群照跑。把它算进「每秒多少条命令」，报出来的就
   * 不是处理能力而是这段刻意设定的节奏。网络往返已经由罐头顶掉，这是同一类
   * 「等待而非工作」的第二处。
   */
  readonly excludedNanoseconds?: () => number;
}

function chatIdForSequence(sequence: number): number {
  return benchmarkChatId(sequence % STATE_MANAGED_CHAT_LIMIT);
}

function joinLogChain(): ChainDefinition {
  return {
    chain: "join-log-append",
    operations: CHAIN_JOIN_LOG_EVENTS,
    recordsPerOperation: 1,
    // 不复用 fixture 的 joinLogEvent：那一份连东京日期一起算好，而
    // `recordJoinLog` 内部还会再算一次，等于在计时窗口里白付一次
    // `new Date` 加日期格式化。这里只给生产入口真正需要的三个字段。
    run: async (sequence: number): Promise<void> => {
      if (!await recordJoinLog({
        chatId: benchmarkChatId(sequence % STATE_MANAGED_CHAT_LIMIT),
        userId: benchmarkUserId(sequence),
        joinedAt: Date.now(),
      })) {
        throw new Error(`Join-log event ${sequence} did not reach the disk.`);
      }
    },
  };
}

function identityPolicyChain(): ChainDefinition {
  return {
    chain: "identity-policy-write",
    operations: CHAIN_IDENTITY_BATCHES,
    recordsPerOperation: IDENTITY_WRITE_BATCH_MAX_ENTRIES,
    // 写透要求主键的正负结论都已预热；生产里那是 update 前置预热做的事，
    // 基准在计时外一次性灌满同一批主键。
    prepare: (): void => {
      hydrateIdentityStorageCounts(0, 0);
      for (let id: number = 1; id <= MAIN_WRITE_THROUGH_WORKING_SET; id += 1) {
        whitelistEntryCache.set(id, null);
        blocklistEntryCache.set(id, null);
      }
    },
    run: async (sequence: number): Promise<void> => {
      const firstOperation: number = sequence * IDENTITY_WRITE_BATCH_MAX_ENTRIES;
      for (
        let offset: number = 0;
        offset < IDENTITY_WRITE_BATCH_MAX_ENTRIES;
        offset += 1
      ) {
        const operation: number = firstOperation + offset;
        const id: number = operation % MAIN_WRITE_THROUGH_WORKING_SET + 1;
        const cycle: number = Math.floor(operation / MAIN_WRITE_THROUGH_WORKING_SET);
        if (!queueIdentityPolicyWrite(
          "whitelist",
          id,
          (cycle & 1) === 0 ? WHITE_ENTRY : null
        )) {
          throw new Error(`Identity write ${operation} was rejected before reaching the Worker.`);
        }
      }
      if (await flushDiskIODomain("whitelist") !== "flushed") {
        throw new Error(`Identity write batch ${sequence} was not committed.`);
      }
    },
  };
}

function chatStateChain(): ChainDefinition {
  return {
    chain: "chat-state-write",
    operations: CHAIN_CHAT_STATE_WRITES,
    recordsPerOperation: 1,
    prepare: (): void => {
      for (let index: number = 0; index < STATE_MANAGED_CHAT_LIMIT; index += 1) {
        getOrCreateChatState(benchmarkChatId(index));
      }
    },
    run: async (sequence: number): Promise<void> => {
      const chatId: number = chatIdForSequence(sequence);
      const state: ChatState = getOrCreateChatState(chatId);
      // 每次都要真的改一个字段：值没变时编码结果一样，量到的就不是一次真实
      // 状态变更的落盘成本。
      state.isAntiRaidEnabled = (sequence & 1) === 0;
      state.title = `Performance fixture chat ${sequence}`;
      await persistChatState(chatId, "performance benchmark chain");
    },
  };
}

function aiMemoryChain(): ChainDefinition {
  return {
    chain: "ai-memory-snapshot",
    operations: CHAIN_AI_MEMORY_SNAPSHOTS,
    recordsPerOperation: 1,
    run: async (sequence: number): Promise<void> => {
      const chatIndex: number = sequence % STATE_MANAGED_CHAT_LIMIT;
      if (!postDiskIO({
        type: "aiMemory",
        chatId: benchmarkChatId(chatIndex),
        revision: sequence + 1,
        snapshot: buildAiMemorySnapshot(chatIndex),
      })) {
        throw new Error(`AI memory snapshot ${sequence} was rejected before reaching the Worker.`);
      }
      if (await flushDiskIODomain("aiMemory") !== "flushed") {
        throw new Error(`AI memory snapshot ${sequence} was not written.`);
      }
    },
  };
}

function diagnosticLogChain(): ChainDefinition {
  return {
    chain: "diagnostic-log",
    operations: CHAIN_LOG_ENTRIES,
    recordsPerOperation: 1,
    run: async (sequence: number): Promise<void> => {
      if (!relayLogMessage({
        timestamp: Date.now(),
        level: "error",
        args: [
          `Performance benchmark diagnostic ${sequence} for chat`,
          benchmarkChatId(sequence % STATE_MANAGED_CHAT_LIMIT),
          benchmarkUserId(sequence),
        ],
      })) {
        throw new Error(`Diagnostic log ${sequence} was refused by the bounded channel.`);
      }
      // 诊断通道只有整轮 flush 会排空（见 infra/diskIO.ts 的 flushDiskIO），
      // 单领域 flush 不等诊断队列，用它量到的会是一条没写完就返回的假链路。
      if (await flushDiskIO() !== "flushed") {
        throw new Error(`Diagnostic log ${sequence} was not written.`);
      }
    },
  };
}

/**
 * 需要罐头出站的链路：它们量的是一条完整命令，处置段会真的调 Telegram。
 * 其余链路只碰内存和磁盘，不装罐头，越界仍旧当场失败。
 */
const COMMAND_CHAINS: ReadonlySet<ChainName> = new Set<ChainName>([
  "ad-detect-command",
  "ai-reply-command",
]);

/** 广告判定链路固定用这一个群：一条命令封一个人，不掺群数扇出。 */
const AD_DETECT_CHAT_INDEX: number = 0;

function adDetectCommandChain(): ChainDefinition {
  const chatId: number = benchmarkChatId(AD_DETECT_CHAT_INDEX);
  return {
    chain: "ad-detect-command",
    operations: CHAIN_AD_DETECT_COMMANDS,
    recordsPerOperation: 1,
    prepare: async (): Promise<void> => {
      // 判定配置在生产里由主线程投递给 Worker；这里用同一个生产入口就地加载。
      ensureAdDetectAgentConfig();
      // 罐头模型响应：形状与 openai chat.completions 一致，永远判为广告，让每一条
      // 命令都走满处置段。判不出广告的那条分支只有入队与结算，量不到落盘。
      adDetectOpenAiClientHolder.current = {
        chat: {
          completions: {
            create: (): Promise<unknown> => Promise.resolve({
              choices: [{
                message: { content: '{"ad":true,"reason":"performance benchmark"}' },
                finish_reason: "stop",
              }],
            }),
          },
        },
      } as never;
      // Worker 段判完把事件投给主线程，主线程 handleAdDetected 起处置——这是生产
      // 的真实接线，处置内部走 confirmBlocklistPersisted 与移除 outbox 的落盘。
      adDetectPublishHolder.current = handleAdDetected;
      const state: ChatState = getOrCreateChatState(chatId);
      state.isAdDetectEnabled = true;
      // managedChatIds 只认「机器人是管理员且已 /init」的群，两个都不给就没有群
      // 可登记移除，量到的会是一条停在黑名单落盘的半截链路。
      state.isInitEnabled = true;
      // 权限快照是后台补齐的，没有可等的句柄；这里有界轮询到它落位为止。拿不到
      // 就直接失败：带着空权限跑，量到的会是一条在登记移除前就短路的半截链路。
      ensureBotChatPermissions(chatId, Date.now());
      for (
        let attempt: number = 0;
        state.botPermissions === undefined && attempt < BOT_PERMISSION_WAIT_ATTEMPTS;
        attempt += 1
      ) {
        await Bun.sleep(BOT_PERMISSION_WAIT_STEP_MS);
      }
      if (state.botPermissions?.isAdministrator !== true) {
        throw new Error("Benchmark bot permissions never resolved to administrator.");
      }
      // 生产热路径读到的是已经拉过一次的管理员缓存；空集合表示发送者都不是管理员。
      cacheAdminIds(chatId, new Set<number>(), Date.now());
    },
    run: async (sequence: number): Promise<void> => {
      // 每条命令换一个发送者：同一个人第二次命中只补触发群那一批，走的是
      // newlyBlocked === false 的短路分支，量到的不再是一条完整命令。
      enqueueAdCandidate({
        type: "adCandidate",
        chatId,
        senderId: benchmarkUserId(sequence),
        messageId: sequence + 1,
        text: `性能基准广告文本 ${sequence}：加我微信 benchmark`,
        label: `Member${sequence}`,
        meta: { firstName: `Member${sequence}`, lastName: "", username: "" },
        isChannel: false,
        isForwarded: false,
        blocked: false,
        justJoined: true,
      }, Date.now());
      await runAdDetectBatch(Date.now());
      if (await drainAdDisposals(AD_DETECT_DRAIN_BUDGET_MS) !== "flushed") {
        throw new Error(`Ad disposal ${sequence} did not settle within the drain budget.`);
      }
    },
  };
}

/** 起一轮回复前先垫进去的上下文条数；空缓冲会让整轮在组装提示词处静默退出。 */
const AI_REPLY_SEED_MESSAGES: number = 12;

/** 把一条群消息按生产入口写进某群的滚动记忆。 */
function recordBenchmarkMessage(
  chatId: number,
  sequence: number,
  messageId: number
): void {
  recordChatMessage({
    type: "record",
    chatId,
    senderId: benchmarkUserId(sequence),
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

/** 等本轮回复自然结束。不能用 quiesceAiChatReplies：那条路是 abort，不是等完成。 */
async function settleReplyRound(sequence: number): Promise<void> {
  for (
    let attempt: number = 0;
    replyGenerationTasks.size > 0 && attempt < AI_REPLY_SETTLE_ATTEMPTS;
    attempt += 1
  ) {
    const tasks: Promise<void>[] = [];
    for (const generationTasks of replyGenerationTasks.values()) {
      tasks.push(...generationTasks);
    }
    if (tasks.length === 0) break;
    await Promise.allSettled(tasks);
  }
  if (replyGenerationTasks.size > 0) {
    throw new Error(`AI reply round ${sequence} never settled.`);
  }
}

function aiReplyCommandChain(): ChainDefinition {
  // 本轮实测到的拟人停顿，由 run 结束时按罐头调用的真实时刻算出。
  const pauseNs: { current: number } = { current: 0 };
  return {
    chain: "ai-reply-command",
    operations: CHAIN_AI_REPLY_COMMANDS,
    recordsPerOperation: 1,
    // 每次操作都被那段停顿拖到秒级，64 次预热要白等两分钟；这条链路的分位数在
    // 个位数次预热后就已经稳定。
    warmupOperations: AI_REPLY_WARMUP_OPERATIONS,
    excludedNanoseconds: (): number => pauseNs.current,
    prepare: (): void => {
      ensureAgentDeploymentConfig();
      botInfoState.current = {
        id: 1,
        username: "benchmark_bot",
        first_name: "benchmark",
      };
      // 罐头文本模型：形状按 @google/genai 的 generateContent 回包，永远给同一段
      // 回复。config_example 的 text 能力配的就是 google，换配置要跟着换这里。
      geminiClientCache.current = new Map([["text", {
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
      for (let index: number = 0; index < STATE_MANAGED_CHAT_LIMIT; index += 1) {
        const chatId: number = benchmarkChatId(index);
        getOrCreateChatState(chatId);
        for (let seed: number = 0; seed < AI_REPLY_SEED_MESSAGES; seed += 1) {
          recordBenchmarkMessage(chatId, seed, seed + 1);
        }
      }
    },
    run: async (sequence: number): Promise<void> => {
      const chatId: number = chatIdForSequence(sequence);
      const messageId: number = AI_REPLY_SEED_MESSAGES + sequence + 1;
      const sentBefore: number = cannedTelegramCalls.get("sendMessage") ?? 0;
      recordBenchmarkMessage(chatId, sequence, messageId);
      generateAndSendReply({
        chatId,
        triggerSenderId: benchmarkUserId(sequence),
        replyToMessageId: messageId,
        imageGenerationRequested: false,
        isRandomTrigger: false,
      });
      await settleReplyRound(sequence);
      // 拟人停顿正好夹在「切成 typing 状态」与「真的把消息发出去」之间。抖动在
      // 生产函数内部取 Math.random()，事后复算不出同一个值，所以按这两次罐头
      // 应答的真实时刻实测。两个时刻都必须在本轮结算之后读：`generateAndSendReply`
      // 是 fire-and-forget，轮开始前读到的 typing 时刻还是上一条命令留下的，
      // 扣出来会跨越整整一条命令而把延迟做成负数。
      const typingAtNs: number = cannedTelegramCallTimes.get("sendChatAction") ?? 0;
      const sentAtNs: number = cannedTelegramCallTimes.get("sendMessage") ?? 0;
      const observedPauseNs: number = sentAtNs - typingAtNs;
      pauseNs.current = observedPauseNs > 0 ? observedPauseNs : 0;
      // 这一轮真的发出了回复才算数。少了这道断言，一次把链路导进静默 return 的
      // 回归（限频、提示词组装拿到空上下文）会表现成读数变快而不是失败。
      if ((cannedTelegramCalls.get("sendMessage") ?? 0) <= sentBefore) {
        throw new Error(`AI reply ${sequence} produced no outgoing message.`);
      }
      // 这里**不**强刷记忆快照。生产是按 30 秒定时器批量刷所有 dirty 群
      // （workers/aiChat/rollingMemory.ts 的 flushDirtyMemories），不是一条回复
      // 一次落盘；每条都强刷会把一笔摊薄到几十条回复上的成本整个记在单条命令头上。
      // 那一笔的真实代价由 `ai-memory-snapshot` 单独一行给出。
    },
  };
}

function createChain(chain: ChainName): ChainDefinition {
  switch (chain) {
    case "join-log-append":
      return joinLogChain();
    case "identity-policy-write":
      return identityPolicyChain();
    case "chat-state-write":
      return chatStateChain();
    case "ai-memory-snapshot":
      return aiMemoryChain();
    case "diagnostic-log":
      return diagnosticLogChain();
    case "ad-detect-command":
      return adDetectCommandChain();
    case "ai-reply-command":
      return aiReplyCommandChain();
  }
}

/** 命令行参数到链路名的严格解析；未知值直接失败，不落到某个默认链路。 */
function parseChainName(value: string | undefined): ChainName {
  switch (value) {
    case "join-log-append":
    case "identity-policy-write":
    case "chat-state-write":
    case "ai-memory-snapshot":
    case "diagnostic-log":
    case "ad-detect-command":
    case "ai-reply-command":
      return value;
    default:
      throw new Error(
        "Chain child expects one of join-log-append|identity-policy-write|" +
        "chat-state-write|ai-memory-snapshot|diagnostic-log|ad-detect-command|" +
        "ai-reply-command."
      );
  }
}

async function measureChain(definition: ChainDefinition): Promise<ChainRound> {
  await definition.prepare?.();
  const warmups: number = definition.warmupOperations ?? CHAIN_WARMUP_OPERATIONS;
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
    // 扣除量夹在 [0, 本次耗时] 内。一次算错的扣除该表现成「这一条没扣干净」，
    // 而不是一行负延迟、负吞吐的读数——后者会被当成基准坏了，而不是这一条坏了。
    const excludedNs: number = Math.min(
      Math.max(definition.excludedNanoseconds?.() ?? 0, 0),
      operationNs
    );
    excludedTotalNs += excludedNs;
    latenciesMs[index] = (operationNs - excludedNs) / 1_000_000;
  }
  // 吞吐必须和分位数扣同一笔。只扣延迟不扣总耗时，这一行就会出现「p50 几十毫秒
  // 却只有零点几条每秒」的自相矛盾读数。
  const elapsedMs: number =
    (Bun.nanoseconds() - startedAtNs - excludedTotalNs) / 1_000_000;
  const io: ProcessIoSnapshot = readProcessIo();
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  const sorted: number[] = [...latenciesMs].sort(
    (left: number, right: number): number => left - right
  );
  let latencySum: number = 0;
  for (const latency of latenciesMs) latencySum += latency;
  const records: number = definition.operations * definition.recordsPerOperation;
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

/**
 * 把业务日志挪到 stderr。
 *
 * stdout 是本子进程回传读数的协议通道（父进程对整个 stdout 做 JSON.parse），而
 * 命令链路每跑一条都会打业务日志，留在 stdout 上会把回执冲成非法 JSON。挪走而
 * 不是丢弃：生产每条命令确实要付一次格式化加写出的代价，静默掉等于在计时窗口
 * 里白送一笔，量出来的命令会比线上便宜。
 */
function routeBusinessLogsToStderr(): void {
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
}

/** 在本进程的 mock 数据根上跑一条链路；Worker 由本函数拉起并负责终止。 */
async function runChainChild(chain: ChainName): Promise<ChainRound> {
  assertBenchmarkRuntimeRoot(RUNTIME_DATA_ROOT);
  routeBusinessLogsToStderr();
  installOutboundGuards();
  // 罐头只给命令链路装，且必须装在硬闸之后才在最外层（理由见 outboundGuard.ts）。
  // 不给其余五条装是有意的：硬闸的第二个作用是「越界出站 = 一次响亮的失败」，
  // 而罐头会把越界变成一次安静的成功。那五条按设计根本碰不到出站，保持它们撞在
  // 硬闸上，将来谁不小心把出站引进那些链路，仍然是当场炸而不是悄悄出一个数。
  if (COMMAND_CHAINS.has(chain)) installCannedTelegramOutbound();
  initDiskIO();
  try {
    await loadPersistedData();
    return await measureChain(createChain(chain));
  } finally {
    await terminateDiskIO();
  }
}

/** `--child chain <name>` 的入口；结果按 JSON 打到 stdout。 */
export async function main(argument: string | undefined): Promise<void> {
  const round: ChainRound = await runChainChild(parseChainName(argument));
  process.stdout.write(`${JSON.stringify(round)}\n`);
}
