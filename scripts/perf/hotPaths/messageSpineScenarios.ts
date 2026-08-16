/**
 * 每条群消息共担的那段主干与自发消息判定两个场景。
 *
 * 与 scenarios.ts 分开：这两条量的是编排主干（handleIncomingMessage 那串固定
 * 调用），改动它们要读的是 auto/message 那一侧，与容器/时间窗那批叶子场景无关。
 */

import type { Message } from "@grammyjs/types";
import type { Context } from "grammy";
import {
  clearAiReplyActivity,
  observeGroupMessageForAiReply,
} from "../../../packages/auto/message/aiReplyActivity";
import { handleIncomingMessage } from "../../../packages/auto/message";
import { handleProactiveMessageActions } from "../../../packages/auto/message/proactive";
import {
  senderUsernameCache,
  userCache,
} from "../../../packages/cache/main/senderIdentity";
import { sentMessages } from "../../../packages/cache/perThread/selfSentTracker";
import { isSelfSent } from "../../../packages/infra/selfSentTracker";
import { cacheSender } from "../../../packages/users/senderIdentity";
import { BENCHMARK_CHAT_ID } from "./fixtures";
import type { Scenario } from "./types";

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
      for (const timer of sentMessages.values()) clearTimeout(timer);
      sentMessages.clear();
    },
    probes: { isSelfSent },
  };
}

/**
 * 每条群消息都要走的编排主干（`auto/message/index.ts` 的 handleIncomingMessage）。
 *
 * 其余场景量的都是叶子工具，而叶子各自快不等于串起来快；这一条量的是真正跑在
 * 每条消息上的那串固定调用：recordChatTitleFromChat → cacheSender → getChatState
 * → observeGroupMessageForAiReply → getActiveCopyIn → isQuietUntilActive →
 * isAiChatActiveIn → handleProactiveMessageActions。
 *
 * **fixture 必须是「无可复制内容」的消息**，这是本场景零副作用的依据，不是随手
 * 挑的：没有 `text`，洗澡触发的第一个条件就不成立；`hasCopyableContent` 为 false，
 * 随机复读（`RANDOM_ECHO_PROBABILITY` = 1/100）也进不去。两道门一关，
 * `sendMessage`/`echoMessage` 在这条路径上不可达。落盘同理——`recordChatTitle`
 * 先查 `isInitEnabled !== true`，而基准进程从不 loadState，
 * `getChatState` 恒返回 DEFAULT_CHAT_STATE，因此 `saveChatStateInBackground` 也不可达。
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
    run: async (iterations: number): Promise<number> => {
      for (let index: number = 0; index < iterations; index += 1) {
        await handleIncomingMessage(ctx);
      }
      return iterations;
    },
    reset: (): void => {
      clearAiReplyActivity();
      userCache.clear();
      senderUsernameCache.clear();
    },
    probes: {
      handleIncomingMessage,
      handleProactiveMessageActions,
      cacheSender,
      observeGroupMessageForAiReply,
    },
  };
}
