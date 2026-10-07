import type { Message } from "grammy/types";
import {
  identityById,
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
import { tryConsumeSlidingWindow } from "../../../packages/libs/slidingWindowRateLimit";
import { TimestampDeque } from "../../../packages/libs/timestampDeque";
import { CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW } from "../../../packages/consts/commands";
import {
  recordJoinWindow,
  stopJoinWindowRuntime,
} from "../../../packages/workers/antiRaid/lockdownJoinWindow";
import { readBotChatPermissions } from "../../../packages/libs/chatMember";
import { cacheSender } from "../../../packages/users/senderIdentity";
import { redactSecretsInText } from "../../../packages/libs/redaction";
import { drawLuckTier } from "../../../packages/commands/luckChallenge/draw";
import { GAG_SESSION_MAX } from "../../../packages/consts/gag";
import {
  COMPACT_BATCH_SIZE,
  VERBATIM_CONTEXT_MAX,
} from "../../../packages/consts/aiChat/memory";
import { collectDueGagSpeakNotices } from "../../../packages/commands/gag/counter";
import { createGagTargetProfileUrl } from "../../../packages/commands/gag/identity";
import type { GagSession } from "../../../packages/types/gag";
import {
  BENCHMARK_CHAT_ID,
  BENCHMARK_EPOCH_MS,
  BENCHMARK_SENDER_ID,
  channelMessageFixture,
  messageFixture,
} from "./fixtures";
import { prototypeProbes } from "./jitTiers";
import type { Scenario } from "./types";

export function senderScenario(username?: string): Scenario {
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
      identityById.clear();
    },
    probes: { cacheSender },
  };
}

/**
 * 同一个群里真实用户与频道马甲混着发言时的 cacheSender 稳态。
 *
 * `from` 与 `sender_chat` 两种消息形态交替进入同一个调用点；`sender-no-username` 与
 * `sender-stable-username` 各只喂一种身份形态，`cacheSender` 是单态读取。
 *
 * 本场景记录 `cacheSender` 的 `reoptRetries`，观察混合输入下的重新优化次数
 * （判读见 hotPaths/types.ts 的 JitTierCounts）。绝对 ns/op 不与
 * `sender-stable-username` 直接相比：后者只有一个发送者，差值含发送者基数。
 *
 * 两种形态交替喂入，发送者 id 各不相同且资料保持不变：命中「发送者资料没变、
 * 逐字段比对后提前返回」的稳态热路径，不是写入路径。
 */
export function senderMixedIdentityScenario(): Scenario {
  const messages: readonly Message[] = [
    messageFixture("stable_user", BENCHMARK_SENDER_ID),
    channelMessageFixture(1, "channel_one"),
    messageFixture("second_user", BENCHMARK_SENDER_ID + 1),
    channelMessageFixture(2, "channel_two"),
  ];
  return {
    iterations: 1_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        checksum += cacheSender(messages[index % messages.length]!) ?? 0;
      }
      return checksum;
    },
    reset: (): void => {
      userCache.clear();
      senderUsernameCache.clear();
      identityById.clear();
    },
    probes: { cacheSender },
  };
}

export function aiActivityScenario(): Scenario {
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

export function aiActivityLruMissScenario(): Scenario {
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

/**
 * 反刷群入群窗口的完整热路径：Map owner、固定容量 TimestampDeque、饱和
 * fail-safe 与每群唯一 timer 均走生产入口。
 */
export function joinTimestampWindowScenario(): Scenario {
  let now: number = BENCHMARK_EPOCH_MS;
  return {
    iterations: 1_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        now += 1;
        checksum += recordJoinWindow(BENCHMARK_CHAT_ID, now) ?? 0;
      }
      return checksum;
    },
    reset: (): void => {
      stopJoinWindowRuntime();
      now = BENCHMARK_EPOCH_MS;
    },
    probes: {
      recordJoinWindow,
      ...prototypeProbes("TimestampDeque", TimestampDeque.prototype, [
        "trim",
        "pushReplacingOldest",
      ]),
    },
  };
}

/**
 * 有硬顶配额窗口的容器成本：`TimestampDeque` + `tryConsumeSlidingWindow` 是
 * 配额型滑动窗口用的那一套（中文动作命令、`/h_image`、运势内联查询、Worker 重启
 * 节流）。容量取生产常量 `CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW`，配额上限即
 * 长度上界，判定只在未满时记账。
 *
 * 每次迭代时钟前进 1 ms；窗口长度为场景内的固定值，与入群窗口（生产 `JOIN_WINDOW_MS`）
 * 不同。
 */
export function quotaTimestampWindowScenario(): Scenario {
  const timestamps: TimestampDeque =
    new TimestampDeque(CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW);
  let now: number = BENCHMARK_EPOCH_MS;
  return {
    iterations: 1_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        now += 1;
        if (tryConsumeSlidingWindow({
          timestamps,
          windowMs: 165,
          maxCalls: CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW,
          now,
        })) checksum += 1;
      }
      return checksum;
    },
    reset: (): void => {
      timestamps.clear();
      now = BENCHMARK_EPOCH_MS;
    },
    probes: {
      tryConsumeSlidingWindow,
      ...prototypeProbes("TimestampDeque", TimestampDeque.prototype, ["push", "trim"]),
    },
  };
}

/**
 * AI 滚动记忆缓冲的容器成本：`BoundedDeque` 是 `cache/workers/aiChat/memory.ts`
 * 里每群逐字上下文缓冲用的容器。
 *
 * 容量与批量取生产常量：满 `VERBATIM_CONTEXT_MAX` 后压缩一块
 * `COMPACT_BATCH_SIZE` 再继续推入，复刻摘要触发前后的进出形状。
 */
export function boundedRollingBufferScenario(): Scenario {
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

/** 脱敏基准使用的占位密钥；均不出现在 BENCHMARK_LOG_LINES 中。 */
const BENCHMARK_SECRETS: readonly string[] = [
  "1234567890:AAF-benchmark-token-value",
  "sk-benchmark-deepseek-key",
  "AIzaSyBenchmarkGeminiKeyValue",
];

/** 不含任何密钥的日志正文，按下标轮换。 */
const BENCHMARK_LOG_LINES: readonly string[] = [
  "Chat title refresh progress: 50/120, elapsed=310ms.",
  "Anti-Raid Worker rejected an ad detection candidate from chat -1001234567890.",
  "Failed to refresh chat title for chat -1009876543210:",
];

/**
 * 日志脱敏在正文不含任何密钥的早退路径上的成本；每条日志的每个参数都经过这条判定。
 */
export function redactCleanLogScenario(): Scenario {
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

/** 固定 roll 输入直接调用生产抽签查表函数，校验和与 JIT 探针均覆盖该入口。 */
export function luckTierTableScenario(): Scenario {
  return {
    iterations: 1_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        const roll: number = index % 100;
        checksum += drawLuckTier(roll).label.length;
      }
      return checksum;
    },
    probes: { drawLuckTier },
  };
}

/**
 * gag 活动群的每消息入口计数：会话数量取生产容量上限 `GAG_SESSION_MAX`，计数达到
 * `GAG_SPEAK_NOTICE_MESSAGE_INTERVAL` 才分配 due 数组；场景在返回的会话上同样把
 * 计数归零。
 */
export function gagSpeakCounterScenario(): Scenario {
  const sessions: GagSession[] = [];
  for (let index: number = 0; index < GAG_SESSION_MAX; index++) {
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
      speakNoticeThreadId: undefined,
      messagesSinceSpeakNotice: 0,
      lastTargetMessageAt: 0,
      speakNoticeRefreshTask: null,
      speakNoticeRefreshTimer: null,
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
 * 每条群消息都要读多次的那张群状态表（`getChatState(chatId).isXEnabled`，
 * 调用点见 antiRaid/updateIngress.ts、antiRaid/floodControl.ts、
 * auto/message/index.ts、aiChat/availability.ts）。
 *
 * Map 查找在循环外：本场景量对象 shape 稳定性，只轮转已经取到手的状态对象。
 *
 * 状态表由不同写入方各设一个字段建出来，复刻生产里各写各的分布；每份 ChatState
 * 都出自 createChatState() 的同一个隐藏类时，这个读取点才拿得到内联缓存。
 * 没有条目的群走 DEFAULT_CHAT_STATE，同样排进轮转。
 *
 * fixture 只复刻各 writer 对应的生产形状，不含字段删除造成的隐藏类迁移；报告仅用于
 * 本场景固定输入下的纵向门禁。
 */
export function chatStateReadScenario(): Scenario {
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
    // 没有条目的群读到 DEFAULT_CHAT_STATE。
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
    // 重新建表；只清空会使每个群读到 DEFAULT_CHAT_STATE。
    reset: (): void => {
      for (const chatId of chatIds) chatStateCache.delete(chatId);
      states = seed();
    },
  };
}

/** 单独量群状态 Map accessor；探针与计时循环实际调用保持一致。 */
export function chatStateMapReadScenario(): Scenario {
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
