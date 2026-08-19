import type { Message } from "@grammyjs/types";
import {
  senderUsernameCache,
  userCache,
} from "../../../packages/cache/main/senderIdentity";
import {
  clearAiReplyActivity,
  observeGroupMessageForAiReply,
} from "../../../packages/auto/message/aiReplyActivity";
import { chatStateCache } from "../../../packages/cache/main/chatState";
import { getChatState, getOrCreateChatState } from "../../../packages/infra/storage/stateStore";
import type { ChatState } from "../../../packages/types/chatState";
import { BoundedDeque } from "../../../packages/libs/boundedDeque";
import { LinkedQueue } from "../../../packages/libs/linkedQueue";
import { trimSlidingWindow } from "../../../packages/libs/slidingWindowRateLimit";
import { readBotChatPermissions } from "../../../packages/libs/chatMember";
import { cacheSender } from "../../../packages/users/senderIdentity";
import {
  appendLinkUrls,
  boundSampleContext,
  claimSampleContextParts,
} from "../../../packages/workers/antiRaid/adDetect/bundle";
import { redactSecretsInText } from "../../../packages/libs/redaction";
import { LUCK_TIERS } from "../../../packages/consts/luckChallenge";
import {
  COMPACT_BATCH_SIZE,
  VERBATIM_CONTEXT_MAX,
} from "../../../packages/consts/aiChat/memory";
import { collectDueGagSpeakNotices } from "../../../packages/commands/gag/counter";
import { createGagTargetProfileUrl } from "../../../packages/commands/gag/identity";
import type { GagSession } from "../../../packages/types/gag";
import type { AdCandidateMessage, AdSampleContext } from "../../../packages/types/antiRaid";
import type { AdCandidateEntry } from "../../../packages/types/antiRaid/adDetect";
import { BENCHMARK_CHAT_ID, BENCHMARK_EPOCH_MS, messageFixture } from "./fixtures";
import {
  floodWindowGrowthScenario,
  floodWindowHitScenario,
  floodWindowSteadyScenario,
} from "./floodScenarios";
import { createLuckReceiptFastPathScenario } from "./luckReceiptScenario";
import {
  incomingMessageSpineScenario,
  selfSentEmptyScenario,
} from "./messageSpineScenarios";
import {
  bufferedMessageBuildScenario,
  mentionFactsScenario,
  replyReferenceScenario,
  transcriptRenderScenario,
} from "./transcriptScenarios";
import { prototypeProbes } from "./jitTiers";
import { createAdCapacityRejectScenario } from "./adDetectScenarios";
import { createIdentityPermissionReadScenario } from "./identityScenarios";
import type { Scenario, ScenarioName } from "./types";

/** 广告无元数据路径的只读空输入，避免基准自身制造额外容器。 */
const EMPTY_LINK_URLS: readonly string[] = [];
/** 广告无上下文路径的只读既有条目。 */
const EMPTY_AD_ENTRIES: readonly AdCandidateEntry[] = [];
/**
 * 送检正文样本，逐轮轮换。
 *
 * 必须换着喂：在「无元数据」这条路上两个被测函数都是立刻返回——
 * `appendLinkUrls` 遇空 URL 表原样返回入参，`boundSampleContext` 遇 undefined
 * 直接返回 undefined——若整个循环体喂的是同一个字面量，循环体就是个常量表达式，
 * JSC 会把它整体提到循环外。实测这会让读数按进程在 ~0.6 ns/op（折叠掉了）和
 * ~11.5 ns/op（没折叠）之间二值跳变，前者量到的根本不是这条路径的成本。
 * 长度也要不同，让 `text.length` 真的随轮次变化。
 *
 * **换输入之后仍有残余二值性**（实测 ~5.8 与 ~14.2 ns/op 两簇），这是这条路径
 * 的固有性质，不是还没修干净：两个函数在此都退化成恒等/立即返回，内联之后本来
 * 就没有多少可测的东西，JSC 折不折叠就决定了读数落在哪一簇。因此本场景应当读作
 * 「这条早退路径有没有变重」的哨兵，而不是一个可跨进程直接比大小的绝对成本；
 * 真要收紧，得换成能产生真实工作量的输入，那已经是另一个场景了。
 *
 * 这张表最早是全仓第一处刻意不 `Object.freeze` 的只读常量——冻结后每轮凭空多
 * 30 ns 的脚手架成本，被测函数直接被淹没（实测同样的取值循环 frozen 35.7~46.2、
 * plain 6.5 ns/op）。后来这条结论推广成了全仓约定，见 AGENTS.md 的「常量」一节。
 */
const AD_SAMPLE_TEXTS: readonly string[] = [
  "ordinary message",
  "another ordinary message",
  "hi",
  "just a normal chat line here",
  "ok",
  "some slightly longer ordinary message body",
  "yet another one",
  "short",
];

function senderScenario(username?: string): Scenario {
  const message: Message = messageFixture(username);
  return {
    iterations: 1_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        checksum += cacheSender(message) ?? 0;
      }
      return checksum;
    },
    reset: (): void => {
      userCache.clear();
      senderUsernameCache.clear();
    },
    probes: { cacheSender },
  };
}

function aiActivityScenario(): Scenario {
  let now: number = BENCHMARK_EPOCH_MS;
  return {
    iterations: 500_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        now += 1;
        checksum += observeGroupMessageForAiReply(BENCHMARK_CHAT_ID, now);
      }
      return checksum;
    },
    reset: (): void => {
      clearAiReplyActivity();
      now = BENCHMARK_EPOCH_MS;
    },
    probes: { observeGroupMessageForAiReply },
  };
}

function aiActivityLruMissScenario(): Scenario {
  let now: number = BENCHMARK_EPOCH_MS;
  let chatId: number = BENCHMARK_CHAT_ID;
  return {
    iterations: 20_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        now += 1;
        chatId -= 1;
        checksum += observeGroupMessageForAiReply(chatId, now);
      }
      return checksum;
    },
    reset: (): void => {
      clearAiReplyActivity();
      now = BENCHMARK_EPOCH_MS;
      chatId = BENCHMARK_CHAT_ID;
    },
    probes: { observeGroupMessageForAiReply },
  };
}

function linkedTimestampWindowScenario(): Scenario {
  const timestamps: LinkedQueue<number> = new LinkedQueue();
  let now: number = BENCHMARK_EPOCH_MS;
  return {
    iterations: 1_000_000,
    run: (iterations: number): number => {
      for (let index: number = 0; index < iterations; index += 1) {
        now += 1;
        trimSlidingWindow({ timestamps, windowMs: 165, now });
        timestamps.push(now);
      }
      return timestamps.size;
    },
    reset: (): void => {
      timestamps.clear();
      now = BENCHMARK_EPOCH_MS;
    },
    probes: {
      trimSlidingWindow,
      ...prototypeProbes("LinkedQueue", LinkedQueue.prototype, ["push"]),
    },
  };
}

/**
 * AI 滚动记忆缓冲的容器成本：`BoundedDeque` 就是 `cache/workers/aiChat/memory.ts`
 * 里每群那一份逐字上下文缓冲用的容器。
 *
 * 容量与批量直接引生产常量：满 `VERBATIM_CONTEXT_MAX` 后压缩一块
 * `COMPACT_BATCH_SIZE` 再继续推入，正是生产里摘要触发前后的进出形状。
 */
function boundedRollingBufferScenario(): Scenario {
  const buffer: BoundedDeque<number> = new BoundedDeque<number>(VERBATIM_CONTEXT_MAX);
  return {
    iterations: 500_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        buffer.push(index);
        if (buffer.size === VERBATIM_CONTEXT_MAX) {
          for (let removed: number = 0; removed < COMPACT_BATCH_SIZE; removed += 1) {
            checksum += buffer.shift() ?? 0;
          }
          checksum += buffer.last(COMPACT_BATCH_SIZE)[0] ?? 0;
        } else if (buffer.size === COMPACT_BATCH_SIZE) {
          checksum += buffer.last(COMPACT_BATCH_SIZE)[0] ?? 0;
        }
      }
      return checksum;
    },
    reset: (): void => {
      buffer.clear();
    },
    probes: prototypeProbes(
      "BoundedDeque",
      BoundedDeque.prototype,
      ["push", "shift", "last"]
    ),
  };
}

function adEmptyMetadataScenario(): Scenario {
  return {
    iterations: 1_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        const sample: string = AD_SAMPLE_TEXTS[index % AD_SAMPLE_TEXTS.length] ?? "";
        const linkedText: string = appendLinkUrls(sample, EMPTY_LINK_URLS);
        const context: AdSampleContext | undefined = boundSampleContext(undefined);
        const text: string = context === undefined
          ? linkedText
          : claimSampleContextParts(linkedText, context, EMPTY_AD_ENTRIES);
        checksum += text.length;
      }
      return checksum;
    },
    // 本场景走的是「无元数据」那条分支：boundSampleContext 恒返回 undefined，
    // claimSampleContextParts 永远不会被调用，因此不登记它。
    probes: { appendLinkUrls, boundSampleContext },
  };
}

function adWireCloneScenario(): Scenario {
  const message: AdCandidateMessage = {
    type: "adCandidate",
    chatId: BENCHMARK_CHAT_ID,
    senderId: 42,
    messageId: 1,
    text: "ordinary message",
    label: "@stable_user",
    meta: { firstName: "Stable", lastName: "", username: "stable_user" },
    isChannel: false,
    isForwarded: false,
    blocked: false,
    justJoined: false,
  };
  return {
    iterations: 200_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        const cloned: AdCandidateMessage = structuredClone(message);
        checksum += cloned.text.length;
      }
      return checksum;
    },
  };
}

/**
 * 日志脱敏在「正文一个密钥都不含」这条主路径上的成本。
 *
 * 每条日志的每个参数都要跑一遍，而生产上几乎所有日志正文都不含密钥；因此这条
 * 早退路径才是它的常态，值得单列一个场景盯着。
 */
const BENCHMARK_SECRETS: readonly string[] = [
  "1234567890:AAF-benchmark-token-value",
  "sk-benchmark-deepseek-key",
  "AIzaSyBenchmarkGeminiKeyValue",
];

const BENCHMARK_LOG_LINES: readonly string[] = [
  "Chat title refresh progress: 50/120, elapsed=310ms.",
  "Anti-Raid Worker rejected an ad detection candidate from chat -1001234567890.",
  "Failed to refresh chat title for chat -1009876543210:",
];

function redactCleanLogScenario(): Scenario {
  return {
    iterations: 1_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        checksum += redactSecretsInText(
          BENCHMARK_LOG_LINES[index % BENCHMARK_LOG_LINES.length]!,
          BENCHMARK_SECRETS
        ).length;
      }
      return checksum;
    },
    probes: { redactSecretsInText },
  };
}

/**
 * 共享常量表的读取代价，以 LUCK_TIERS 为样本。
 *
 * 循环体逐字照抄 commands/luckChallenge/draw.ts 的 drawLuckTier（那个函数没有
 * 导出，但它就是这张表在生产上唯一的读法：按权重累加线性扫），读的也是生产
 * 那一份常量本体，不另造 fixture。
 *
 * 存在的理由是给「常量表要不要 Object.freeze」这个决定留一把尺子：JSC 对冻结
 * 数组的下标读取和 for-of 都没有快路径，量级差一个数量级。
 */
function luckTierTableScenario(): Scenario {
  return {
    iterations: 1_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        const roll: number = index % 100;
        let cumulative: number = 0;
        for (const tier of LUCK_TIERS) {
          cumulative += tier.weight;
          if (roll < cumulative) { checksum += tier.label.length; break; }
        }
      }
      return checksum;
    },
  };
}

/**
 * gag 活动群的每消息入口计数：五条会话复刻全局容量上限，每 15 次才允许分配
 * due 数组；调用方在真实换新成功后同样把对应计数归零。
 */
function gagSpeakCounterScenario(): Scenario {
  const sessions: GagSession[] = [];
  for (let index: number = 0; index < 5; index++) {
    const targetId: number = 100 + index;
    const session: GagSession = {
      chatId: BENCHMARK_CHAT_ID,
      targetId,
      targetProfileUrl: createGagTargetProfileUrl({ id: targetId }),
      targetLabel: "Benchmark target",
      chatLabel: "Performance fixture",
      tool: "口塞",
      durationMinutes: 5,
      phase: "active",
      expiresAt: Number.MAX_SAFE_INTEGER,
      publicNoticeMessageId: 1_000 + index,
      speakNoticeMessageId: 2_000 + index,
      pendingSpeakNoticeMessageId: 0,
      retiredSpeakNoticeMessageId: 0,
      messagesSinceSpeakNotice: 0,
      speakNoticeRefreshTask: null,
      noticePending: false,
      timer: null,
      cleanupRetryIndex: 0,
      cleanupTimer: null,
      endingTask: null,
    };
    sessions.push(session);
  }
  return {
    iterations: 2_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index++) {
        const due: GagSession[] | null = collectDueGagSpeakNotices(
          sessions,
          BENCHMARK_EPOCH_MS
        );
        if (due === null) continue;
        checksum += due.length;
        for (const session of due) session.messagesSinceSpeakNotice = 0;
      }
      return checksum;
    },
    reset: (): void => {
      for (const session of sessions) session.messagesSinceSpeakNotice = 0;
    },
    probes: { collectDueGagSpeakNotices },
  };
}

/**
 * 每条群消息都要读 4~6 次的那张群状态表（`getChatState(chatId).isXEnabled`，
 * 调用点见 antiRaid/updateIngress.ts、antiRaid/floodControl.ts、
 * antiRaid/adCandidate.ts、auto/message/index.ts、aiChat/availability.ts）。
 *
 * **Map 查找刻意提到循环外**：本场景量的是对象 shape 稳定性，而不是
 * `chatStateCache.get`。把 `getChatState` 整个放进循环的话，哈希查找的成本会盖住
 * property access 那几纳秒，两种形状的读数在本机噪声里分不开——先前试过，
 * 基线与修复版都落在 18~32 ns/op 的同一片区间。这里只轮转已经取到手的状态对象，
 * 量的正好是 D1 改动的那一步。
 *
 * 状态表刻意由不同写入方各设一个字段建出来，复刻生产里各写各的那种分布：只有
 * 当每份 ChatState 都出自 createChatState() 的同一个隐藏类时，这个读取点才拿得到
 * 内联缓存。没有条目的群走 DEFAULT_CHAT_STATE，它也必须是同一个形状，因此一并
 * 排进轮转。
 *
 * 本机 Bun 1.3.14 各跑 3 次的中位数：规范形状 5.57 / 5.89 / 5.96，改动前的发散
 * 形状 5.78 / 6.22 / 7.50 ns/op——修复侧更快且离散度明显更小。**不要拿它去对
 * 「2 倍」那个数**：那份读数来自只量 property access、且把加字段后再 delete 的
 * 形状迁移也算进去的微基准，这个 fixture 只复刻了 7 种形状，没有 delete 迁移。
 */
function chatStateReadScenario(): Scenario {
  const writers: readonly ((state: ChatState) => void)[] = [
    (state: ChatState): void => { state.isInitEnabled = true; },
    (state: ChatState): void => { state.isAntiRaidEnabled = true; },
    (state: ChatState): void => { state.title = "fixture"; },
    (state: ChatState): void => {
      state.botPermissions = readBotChatPermissions({
        status: "member",
        user: { id: 1, is_bot: true, first_name: "fixture" },
      });
    },
    (state: ChatState): void => { state.isAdDetectEnabled = true; },
    (state: ChatState): void => { state.isFloodControlEnabled = true; },
  ];
  const chatIds: number[] = [];
  for (let index: number = 0; index < writers.length; index += 1) {
    chatIds.push(BENCHMARK_CHAT_ID - index);
  }
  const seed = (): Readonly<ChatState>[] => {
    const states: Readonly<ChatState>[] = [];
    for (let index: number = 0; index < writers.length; index += 1) {
      const chatId: number = chatIds[index]!;
      writers[index]!(getOrCreateChatState(chatId));
      states.push(getChatState(chatId));
    }
    // 没有条目的群：它交出来的 DEFAULT_CHAT_STATE 若与上面几份不同形状，
    // 这个读取点照样是多态的。
    states.push(getChatState(BENCHMARK_CHAT_ID - 999));
    return states;
  };
  let states: Readonly<ChatState>[] = seed();
  return {
    iterations: 20_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      const length: number = states.length;
      for (let index: number = 0; index < iterations; index += 1) {
        if (states[index % length]!.isAntiRaidEnabled === true) checksum += 1;
      }
      return checksum;
    },
    // 重新建表而不是只清空：清空之后每个群都退化成 DEFAULT_CHAT_STATE，后续
    // 样本量到的就不再是「多个群各自的状态」这条路径了。
    reset: (): void => {
      for (const chatId of chatIds) chatStateCache.delete(chatId);
      states = seed();
    },
  };
}

/** 单独量群状态 Map accessor；探针与计时循环实际调用保持一致。 */
function chatStateMapReadScenario(): Scenario {
  const chatIds: readonly number[] = [
    BENCHMARK_CHAT_ID,
    BENCHMARK_CHAT_ID - 1,
    BENCHMARK_CHAT_ID - 2,
    BENCHMARK_CHAT_ID - 3,
  ];
  return {
    iterations: 10_000_000,
    prepare: (): void => {
      for (const chatId of chatIds) getOrCreateChatState(chatId);
    },
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        if (
          getChatState(chatIds[index % chatIds.length]!).isAntiRaidEnabled ===
          true
        ) {
          checksum += 1;
        }
      }
      return checksum;
    },
    reset: (): void => {
      for (const chatId of chatIds) chatStateCache.delete(chatId);
    },
    probes: { getChatState },
  };
}

export function createScenario(name: ScenarioName): Scenario {
  switch (name) {
    case "sender-no-username":
      return senderScenario();
    case "sender-stable-username":
      return senderScenario("Stable_User");
    case "luck-receipt-fast-path":
      return createLuckReceiptFastPathScenario();
    case "ai-activity-window":
      return aiActivityScenario();
    case "ai-activity-lru-miss":
      return aiActivityLruMissScenario();
    case "ad-empty-metadata":
      return adEmptyMetadataScenario();
    case "ad-wire-clone":
      return adWireCloneScenario();
    case "ad-capacity-reject":
      return createAdCapacityRejectScenario();
    case "identity-permission-read":
      return createIdentityPermissionReadScenario();
    case "linked-timestamp-window":
      return linkedTimestampWindowScenario();
    case "bounded-rolling-buffer":
      return boundedRollingBufferScenario();
    case "chat-state-read":
      return chatStateReadScenario();
    case "chat-state-map-read":
      return chatStateMapReadScenario();
    case "self-sent-empty":
      return selfSentEmptyScenario();
    case "incoming-message-spine":
      return incomingMessageSpineScenario();
    case "flood-window-hit":
      return floodWindowHitScenario();
    case "flood-window-growth":
      return floodWindowGrowthScenario();
    case "flood-window-steady":
      return floodWindowSteadyScenario();
    case "gag-speak-counter":
      return gagSpeakCounterScenario();
    case "buffered-message-build":
      return bufferedMessageBuildScenario();
    case "transcript-render":
      return transcriptRenderScenario();
    case "reply-reference":
      return replyReferenceScenario();
    case "mention-facts":
      return mentionFactsScenario(true);
    case "mention-facts-plain":
      return mentionFactsScenario(false);
    case "redact-clean-log":
      return redactCleanLogScenario();
    case "luck-tier-table":
      return luckTierTableScenario();
  }
}
