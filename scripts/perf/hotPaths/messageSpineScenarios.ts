/**
 * 每条群消息共担的那段主干、自发消息判定，以及 AI 开启后媒体分支的纯计算段。
 *
 * 与 scenarios.ts 分开：这几条量的是编排主干（handleIncomingMessageMiddleware 那串固定
 * 调用），改动它们要读的是 auto/message 那一侧，与容器/时间窗那批叶子场景无关。
 */

import type { Message } from "grammy/types";
import type { Context } from "grammy";
import { resolveSpeaker } from "../../../packages/auto/message/facts";
import { buildAiRecordMediaMessage } from "../../../packages/auto/message/recordContext";
import { createMessageTriggerContext } from "../../../packages/auto/message/triggerContext";
import { claimRandomMediaTrigger } from "../../../packages/auto/message/triggerPolicy";
import type { AiBotInfo, AiRecordMediaMessage } from "../../../packages/types/aiChat/protocol";
import type { AiSpeakerSnapshot } from "../../../packages/types/aiChat/speaker";
import type { MessageTriggerContext, RandomMediaTrigger } from "../../../packages/types/auto";
import type { ChatState } from "../../../packages/types/chatState";
import {
  clearAiReplyActivity,
  observeGroupMessageForAiReply,
} from "../../../packages/auto/message/aiReplyActivity";
import { handleIncomingMessageMiddleware } from "../../../packages/auto/message";
import { handleProactiveMessageActions } from "../../../packages/auto/message/proactive";
import {
  senderUsernameCache,
  userCache,
} from "../../../packages/cache/main/senderIdentity";
import { aiChatConfigReadinessCache } from
  "../../../packages/cache/main/configReadiness";
import { chatStateCache } from "../../../packages/cache/main/chatState";
import {
  resetSelfSentTracker,
  sentMessages,
} from "../../../packages/cache/perThread/selfSentTracker";
import { isSelfSent } from "../../../packages/infra/selfSentTracker";
import { getOrCreateChatState } from "../../../packages/infra/storage/stateStore";
import { cacheSender } from "../../../packages/users/senderIdentity";
import { BENCHMARK_CHAT_ID, BENCHMARK_EPOCH_MS } from "./fixtures";
import type { Scenario } from "./types";

/** 空闲机器人：15 秒内一条都没发过，isSelfSent 在外层就落空。 */
export function selfSentEmptyScenario(): Scenario {
  return {
    iterations: 2_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        if (isSelfSent(BENCHMARK_CHAT_ID, index)) checksum += 1;
      }
      return checksum;
    },
    reset: (): void => {
      resetSelfSentTracker();
    },
    probes: { isSelfSent },
  };
}

/** 活跃机器人在一个 TTL 窗口内的自发消息群数与每群条数，取常见群规模的稳态。 */
const ACTIVE_SELF_SENT_CHATS: number = 12;
const ACTIVE_SELF_SENT_PER_CHAT: number = 4;

/**
 * **活跃**机器人下的回环判定：`sentMessages` 非空，外层快速路径不再生效。
 *
 * 与 self-sent-empty 成对存在，缺了这一条就只量到了空闲那一半——而这条判定在
 * 每条群消息上最多要跑 5 次（调用点清单见 infra/selfSentTracker.ts 头注），
 * 只要机器人在 SELF_SENT_MESSAGE_TTL_MS 内发过任何一条消息，走的就全是这一支。
 *
 * 每轮按「一条群消息 5 次查询」计一次迭代，与生产的调用密度对齐；其中一次落在
 * 已登记的编号上，其余全部未命中，接近真实分布（回环是少数）。
 *
 * 表由 reset 直接填充，**不经 markSelfSent**：那条路挂的是 SELF_SENT_MESSAGE_TTL_MS
 * （15 秒）的真 timer，而 JIT 稳定轮 + 预热 + 多次采样的总时长会越过它，表会在测量
 * 中途被清空——那时这个场景就静默变成了 self-sent-empty，读数还看不出异常。
 * 占位值用一个已 clearTimeout 的真 Timeout：类型正确、永远不会触发，
 * 被测的 isSelfSent 也只做 has()，从不读它。
 */
export function selfSentActiveScenario(): Scenario {
  const chatIds: number[] = [];
  for (let index: number = 0; index < ACTIVE_SELF_SENT_CHATS; index += 1) {
    chatIds.push(BENCHMARK_CHAT_ID - index);
  }
  return {
    iterations: 400_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        const chatId: number = chatIds[index % ACTIVE_SELF_SENT_CHATS]!;
        if (isSelfSent(chatId, index % ACTIVE_SELF_SENT_PER_CHAT)) checksum += 1;
        for (let probe: number = 1; probe < 5; probe += 1) {
          if (isSelfSent(chatId, 1_000_000 + index + probe)) checksum += 1;
        }
      }
      return checksum;
    },
    reset: (): void => {
      resetSelfSentTracker();
      const placeholder: ReturnType<typeof setTimeout> = setTimeout((): void => undefined, 0);
      clearTimeout(placeholder);
      for (const chatId of chatIds) {
        const byMessage: Map<number, ReturnType<typeof setTimeout>> =
          new Map<number, ReturnType<typeof setTimeout>>();
        for (let message: number = 0; message < ACTIVE_SELF_SENT_PER_CHAT; message += 1) {
          byMessage.set(message, placeholder);
        }
        sentMessages.set(chatId, byMessage);
      }
    },
    probes: { isSelfSent },
  };
}

/**
 * 每条群消息都要走的编排主干（`auto/message/index.ts` 的 handleIncomingMessageMiddleware）。
 *
 * 其余场景量的都是叶子工具，而叶子各自快不等于串起来快；这一条量的是真正跑在
 * 每条消息上的那串固定调用：getChatState → recordChatTitleFromChat → cacheSender
 * → observeGroupMessageForAiReply → getActiveCopyIn → isQuietUntilActive →
 * isAiChatConfigured → handleProactiveMessageActions。
 *
 * **fixture 必须是「无可复制内容」的消息**，这是本场景零副作用的依据，不是随手
 * 挑的：没有 `text`，洗澡触发的第一个条件就不成立；`hasCopyableContent` 为 false，
 * 随机复读（`RANDOM_ECHO_PROBABILITY` = 1/100）也进不去。两道门一关，
 * `sendMessage`/`echoMessage` 在这条路径上不可达。落盘同理——prepare 建立一份
 * 标题已经一致的受管群状态，`recordChatTitle` 同步比较后直接返回，因此
 * `saveChatStateInBackground` 不可达。AI 配置 readiness 也直接预置为成功，但
 * 群开关保持关闭：这既覆盖生产已配置进程的稳态判定，又不投递 Worker，并避免
 * 基准读取部署方的 config/。
 * 部署机上 bot 常驻运行、共用同一份 SQLite 和 token，这两条不可达性是本场景
 * 能安全存在的前提；改 fixture 前必须重新验证它们。
 *
 * 覆盖范围要说清楚：AI 关闭时不进各载荷 handler（生产同理），因此这条量的是
 * 「所有消息共担的那段」，不含 AI 开启后的文本/贴纸分支。
 */
export function incomingMessageSpineScenario(): Scenario {
  const chat: Message["chat"] = {
    id: BENCHMARK_CHAT_ID,
    type: "supergroup",
    title: "Performance fixture",
  };
  const message: Message = {
    message_id: 1,
    date: 1,
    chat,
    from: { id: 42, is_bot: false, first_name: "Stable", last_name: "Sender" },
    pinned_message: { message_id: 0, date: 0, chat },
  };
  const ctx: Context = {
    msg: message,
    me: { id: 4242, is_bot: true, first_name: "Tensai", username: "tensai_bot" },
  } as unknown as Context;
  return {
    iterations: 200_000,
    prepare: (): void => {
      const state: ChatState = getOrCreateChatState(BENCHMARK_CHAT_ID);
      state.isInitEnabled = true;
      state.title = chat.title;
      aiChatConfigReadinessCache.current = { ok: true };
    },
    run: (iterations: number): number => {
      for (let index: number = 0; index < iterations; index += 1) {
        const pending: Promise<void> | undefined = handleIncomingMessageMiddleware(ctx);
        if (pending !== undefined) {
          throw new Error("Incoming message spine unexpectedly produced async work");
        }
      }
      return iterations;
    },
    reset: (): void => {
      clearAiReplyActivity();
      userCache.clear();
      senderUsernameCache.clear();
      chatStateCache.delete(BENCHMARK_CHAT_ID);
      aiChatConfigReadinessCache.current = null;
    },
    probes: {
      handleIncomingMessageMiddleware,
      handleProactiveMessageActions,
      cacheSender,
      observeGroupMessageForAiReply,
    },
  };
}

/**
 * AI 开启后，每条**媒体**消息共担的纯计算段。
 *
 * incoming-message-spine 的 fixture 是「无可复制内容且 AI 关闭」，不进入载荷
 * handler；本场景覆盖 AI 开启时的一次触发上下文、掷骰判定与 22 字段媒体载荷。
 *
 * **fixture 刻意选「回复机器人的图片」这条直接唤起路径**，这是本场景零副作用与
 * 可复现的依据，不是随手挑的：
 * - 有 directTriggerReason 时 shouldAttemptRandomTrigger 在第一个条件就短路，
 *   因此不调 Math.random()、不写 userReplyTriggerTimes、不排 timer——读数可复现，
 *   也不会让门禁的 retained/RSS 判据混进一张会增长的冷却表。
 * - 三个被测函数（triggerContext.ts / triggerPolicy.ts / recordContext.ts）连同它们
 *   依赖的 facts.ts 全是纯函数，只 import 常量与类型，不碰配置、缓存、Worker 与网络。
 *   这里**不**调 recordChatMedia：那一步会 postAiChatOrThrow 到 AI Worker，
 *   而基准进程从不启动它。
 */
export function aiMediaDirectTriggerScenario(): Scenario {
  const bot: AiBotInfo = { id: 4242, first_name: "Tensai", username: "tensai_bot" };
  const chat: Message["chat"] = {
    id: BENCHMARK_CHAT_ID,
    type: "supergroup",
    title: "Performance fixture",
  };
  // 被回复的那条用 ReplyMessage 形态（Telegram 不会再往下嵌一层 reply_to_message）。
  const repliedTo: NonNullable<Message["reply_to_message"]> = {
    message_id: 41,
    date: 1,
    chat,
    from: { id: bot.id, is_bot: true, first_name: "Tensai", username: "tensai_bot" },
    text: "机器人之前说的话",
    // ReplyMessage 按 Telegram 的实际形态不再嵌套下一层被回复消息。
    reply_to_message: undefined,
  };
  const message: Message = {
    message_id: 42,
    date: 1,
    chat,
    from: { id: 7, is_bot: false, first_name: "Stable", last_name: "Sender", username: "stable_user" },
    caption: "看看这张",
    photo: [{ file_id: "AgACAgUAAx", file_unique_id: "AQADu", width: 1280, height: 720, file_size: 90_000 }],
    reply_to_message: repliedTo,
  };
  return {
    iterations: 300_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        // resolveSpeaker 必须留在循环里：生产的每个媒体 handler 都是每条消息解析
        // 一次发言人身份（并为此造一个 AiSpeakerSnapshot）。提到循环外既少量了一次
        // 每消息分配，也会让它作为门禁探针形同虚设——那条断言要求每个生产探针在
        // 采样期确实跑在 DFG 稳态上，没被调用的函数满足不了它想证明的东西。
        const speaker: AiSpeakerSnapshot = resolveSpeaker(message);
        // now 逐轮递增：生产里它是每条消息各自的 Date.now()，喂同一个字面量会让
        // 整个循环体退化成常量表达式（同 scenarios.ts 里 AD_SAMPLE_TEXTS 那段的理由）。
        const context: MessageTriggerContext = createMessageTriggerContext({
          message,
          bot,
          now: BENCHMARK_EPOCH_MS + index,
          isQuiet: false,
          aiReplyProbability: 1 / 40,
        });
        const claim: RandomMediaTrigger = claimRandomMediaTrigger(context, speaker.id);
        const payload: AiRecordMediaMessage = buildAiRecordMediaMessage({
          context,
          speaker,
          media: {
            kind: "photo",
            caption: "看看这张",
            fileId: "AgACAgUAAx",
            fileUniqueId: "AQADu",
            width: 1280,
            height: 720,
            commentOnResolve: claim === "claimed",
            stickerFallbackText: undefined,
            voiceMime: undefined,
            voiceDurationSeconds: 0,
          },
        });
        checksum += payload.width + (payload.directTriggerReason === undefined ? 0 : 1);
      }
      return checksum;
    },
    probes: {
      createMessageTriggerContext,
      claimRandomMediaTrigger,
      buildAiRecordMediaMessage,
      resolveSpeaker,
    },
  };
}
