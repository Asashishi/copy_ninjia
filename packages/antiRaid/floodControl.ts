/**
 * 刷屏禁言在主线程侧的那一半：只有投递。
 *
 * 计数窗口、身份确证、禁言与群内通知全部在入群守卫线程执行，见
 * workers/antiRaid/floodControl.ts。这里只把一条群消息收敛成无状态的投递；
 * 按群开关、聊天类型、可禁言成员身份与白名单豁免均在创建候选对象前完成。
 *
 * 投递走普通 post 而非 durable 边界，与广告检测同理：窗口随 isolate 生死，
 * 为每条群消息加一道跨线程屏障换不来任何恢复能力。
 */

import { formatUserLabel } from "../users/userLabel";
import { visibleSenderChat } from "../users/visibleSender";
import { getChatState } from "../infra/storage/stateStore";
import { canBypassFloodControl } from "./memberFacts";
import type { FloodCandidateMessage } from "../types/antiRaid/protocol";
import type { ChatState } from "../types/chatState";
import type { Message, User } from "grammy/types";

/** buildFloodCandidate 的入参；四项越过位置参数上限，故收成 options。 */
export interface BuildFloodCandidateParams {
  readonly message: Message;
  /** 本机器人的用户 id；自己发的消息不计数。 */
  readonly botId: number;
  /**
   * 本条 update 统一的「现在」，随候选发给 Worker 当作窗口时刻。
   * 调用方一律传 updateNow() 的返回值，见 infra/updateContext.ts。
   */
  readonly now: number;
  /** 同一同步消息入口已读取的当前群状态；缺省时本函数自行读取。 */
  readonly chatState?: Readonly<ChatState>;
}

/** 把一条群消息收敛成刷屏计数投递。返回 undefined 表示这条不参与计数。 */
export function buildFloodCandidate({
  message,
  botId,
  now,
  chatState,
}: BuildFloodCandidateParams): FloodCandidateMessage | undefined {
  // 只在超级群计数：`restrictChatMember` 按 Bot API 的定义只对超级群有效，
  // 普通群里连计数都是白占内存——攒满一整个窗口只换来一次注定失败的请求和
  // 一行把运维引向权限配置的报错。普通群升级成超级群之后消息自带新的
  // chat.type，这道门禁随之自愈。
  if (message.chat.type !== "supergroup") return undefined;
  // 缺省关闭；在任何身份解析、白名单查询和候选对象创建之前直接返回。
  const currentState: Readonly<ChatState> =
    chatState ?? getChatState(message.chat.id);
  if (currentState.isFloodControlEnabled !== true) return undefined;
  // 频道马甲与匿名管理员没有可禁言的成员身份：restrictChatMember 只认真实用户，
  // 拿频道/群 id 去调只会换一句报错，而皮套底下是谁 Telegram 并不暴露——与
  // `/block` 拒绝把当前群身份当成员目标是同一条理由。
  if (visibleSenderChat(message) !== undefined) return undefined;

  const sender: User | undefined = message.from;
  if (sender === undefined || sender.id === botId) return undefined;
  if (canBypassFloodControl(sender.id)) return undefined;

  return {
    type: "floodCandidate",
    chatId: message.chat.id,
    userId: sender.id,
    observedAt: now,
    // 昵称是用户可控内容，清洗与退化都收在 formatUserLabel 里；Worker 侧只把
    // 它当纯文本拼进通知，出站消息一律不设 parse_mode（见 docs/cn/04-invariants.md）。
    //
    // 直接把 `sender` 交进去，不再现造一个 `{ id, username, first_name }` 投影：
    // formatUserLabel 只读 username / isChannel / title / first_name，grammY 的
    // `User` 在这四项上与 CachedUser 逐字兼容（没有 isChannel 即按真人分支走），
    // 而这条路跑在每条计入刷屏窗口的群消息上，投影对象是一次纯浪费的分配。
    label: formatUserLabel(sender),
  };
}
