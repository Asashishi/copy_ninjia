/**
 * 刷屏禁言在主线程侧的那一半：只有投递。
 *
 * 计数窗口、身份确证、禁言与群内通知全部在入群守卫线程执行，见
 * workers/antiRaid/floodControl.ts。这里只把一条群消息收敛成无状态的投递；
 * 按群开关、聊天类型、可禁言成员身份与白名单豁免均在创建候选对象前完成。
 *
 * 投递走普通 post，不经 durable 边界（与广告检测相同）：计数窗口随 Worker isolate 生灭。
 */

import { visibleSenderChat } from "../users/visibleSender";
import { canBypassFloodControl } from "./memberFacts";
import type { FloodCandidateMessage } from "../types/antiRaid/protocol";
import type { ChatState } from "../types/chatState";
import type { Message, User } from "grammy/types";

/** buildFloodCandidate 的入参。 */
export interface BuildFloodCandidateParams {
  readonly message: Message;
  /** 本机器人的用户 id；自己发的消息不计数。 */
  readonly botId: number;
  /**
   * 本条 update 统一的「现在」，随候选发给 Worker 当作窗口时刻。
   * 调用方一律传 updateNow() 的返回值，见 infra/updateContext.ts。
   */
  readonly now: number;
  /** 同一同步消息入口已读取的当前群状态。 */
  readonly chatState: Readonly<ChatState>;
}

/** 把一条群消息收敛成刷屏计数投递。返回 undefined 表示这条不参与计数。 */
export function buildFloodCandidate({
  message,
  botId,
  now,
  chatState,
}: BuildFloodCandidateParams): FloodCandidateMessage | undefined {
  // 只在超级群计数：`restrictChatMember` 只对超级群有效。
  if (message.chat.type !== "supergroup") return undefined;
  // 缺省关闭；在任何身份解析、白名单查询和候选对象创建之前直接返回。
  if (chatState.isFloodControlEnabled !== true) return undefined;
  // 频道马甲与匿名管理员没有可禁言的成员身份（restrictChatMember 只认真实用户），
  // 与 `/block` 拒绝把当前群身份当成员目标是同一约束。
  if (visibleSenderChat(message) !== undefined) return undefined;

  const sender: User | undefined = message.from;
  if (sender === undefined || sender.id === botId) return undefined;
  if (canBypassFloodControl(sender.id)) return undefined;

  return {
    type: "floodCandidate",
    chatId: message.chat.id,
    userId: sender.id,
    observedAt: now,
    // 昵称清洗推迟到 Worker 真的禁言时（见 workers/antiRaid/floodControl.ts）。
    name: sender.username ? `@${sender.username}` : sender.first_name,
  };
}
