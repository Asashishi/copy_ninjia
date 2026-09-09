import type { CommandContext, Context } from "grammy";
import type { ChatState } from "../types/chatState";
import type { ReadonlyLruCache } from "../libs/lruCache";
import {
  INIT_CHAT_LIMIT_TEXT,
  INIT_DISABLE_TEARDOWN_FAILED_TEXT,
  INIT_TOGGLE_TEXTS,
} from "../consts/commands";
import { STATE_MANAGED_CHAT_LIMIT } from "../consts/storage";
import { logger } from "../infra/logger";
import {
  clearChatStateField,
  getChatStateCache,
  getOrCreateChatState,
  persistChatState,
} from "../infra/storage/stateStore";
import { sendCommandMessage } from "../infra/telegram";
import { resolveSuperAdminToggleArg, toggleReplyText } from "./superAdminToggle";
import { invalidateBotAdminStatus, resolveBotAdminStatus } from "../infra/botAdmin";
import { teardownChatRuntime } from "../infra/chatTeardown";

/**
 * 处理 /init enable|disable 指令：按群开关机器人是否处理这个群的更新（见
 * ChatState.isInitEnabled，缺省未初始化）。禁用/未初始化时，这个群的更新在
 * app/registerHandlers.ts 最前端的网关中间件处直接丢弃，不做任何监听/
 * 复读/AI 相关工作
 * ——只有超级管理员可以控制这个总开关。
 */
export async function handleInitCommand(ctx: CommandContext<Context>): Promise<void> {
  const arg: "enable" | "disable" | undefined = await resolveSuperAdminToggleArg(ctx, {
    texts: INIT_TOGGLE_TEXTS,
  });
  if (!arg) return;

  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const knownChats: ReadonlyLruCache<number, ChatState> = getChatStateCache();
  if (
    arg === "enable" &&
    !knownChats.has(chatId) &&
    knownChats.size >= STATE_MANAGED_CHAT_LIMIT
  ) {
    await sendCommandMessage({
      chatId,
      text: INIT_CHAT_LIMIT_TEXT,
      replyToMessageId: messageId,
    });
    return;
  }
  const state: ChatState = getOrCreateChatState(chatId);
  const wasEnabled: boolean = state.isInitEnabled === true;
  const isEnabled: boolean = arg === "enable";
  state.isInitEnabled = isEnabled;
  // 唯一不作废的情形：对已经启用的群重复 /init enable。那是一次空操作，若
  // 照样作废，随后的重新判定会让 recordBotChatPermissions 看到未知 -> 管理员，
  // 被当成一次全新的边沿，把整份黑名单再清扫一遍（名单几百条时就是几百次
  // getChatMember 压进验证队列）。disable 一律作废——关掉之后这份权限记录
  // 本来就不该继续被信任。
  if (!(isEnabled && wasEnabled)) invalidateBotAdminStatus(chatId);
  if (arg === "disable") {
    // 群名只为「在管的群」而记（infra/chatTitle.ts 的 applyChatTitle 同样只认
    // isInitEnabled === true），关掉之后它就是一条没有任何人会读的残留。而它偏偏是
    // isEmptyChatState 的判据之一：不清的话，这条记录既不空、也不再被管理，却继续占着
    // STATE_MANAGED_CHAT_LIMIT 的一个名额——25 轮「启用又关掉」之后，/init enable 对任何
    // 新群都只回 INIT_CHAT_LIMIT_TEXT，而实际在管的群可能是零个，且没有任何命令能删掉
    // 这些残留行。清完若整条状态回到缺省，clearChatStateField 会顺手删掉 LRU 条目，下面
    // 那次 persistChatState 写出的就是删除墓碑，SQLite 行一并消失。
    //
    // **只清 title，功能开关一律保留**：那几个开关是运维按下的决策，title 只是
    // 每条群消息顺手刷回来的派生值。清开关等于让一次 /init disable 静默丢掉本群的
    // AI、广告检测、防刷屏配置，重新 enable 时既恢复不了也不会有任何提示。代价是
    // 「总开关关了、功能开关还开着」的群继续占一个 STATE_MANAGED_CHAT_LIMIT 名额，
    // 直到那几个开关被逐条关掉、或机器人被移出该群（离群走 pruneDepartedChatState）。
    // 这条代价由 INIT_CHAT_LIMIT_TEXT 如实告诉撞上上限的人，不靠删配置掩盖。
    clearChatStateField(chatId, "title");
  }
  // **落盘先于运行时拆除**，与 commands/superAdminToggle.ts 的 runChatToggleCommand
  // 同序：teardownChatRuntime 里有不可逆的持久化动作（aiChat owner 的 durable 记忆
  // 删除、translate owner 的会话删除），反过来做的话，落盘一旦失败就是「磁盘上开关
  // 还开着、本群的 AI 记忆已经没了」。
  //
  // 这一次失败照旧原样上抛：那是 fatal durability failure，这条 update 不能被确认
  // （见 docs/cn/04-invariants.md）。此刻还什么都没写进去，因此重投那一轮读到的
  // wasEnabled 仍是 true，回执不会出现「本来就关着」那种歧义。
  await persistChatState(chatId, "init toggled");

  // 拆运行态失败**不上抛**。总开关上面已经 durable 地关掉，异常逸出只会让
  // acknowledged runner 带非零码退出且不确认 offset：Telegram 重投同一条
  // /init disable，而那时 wasEnabled 已经是 false，管理员第一次什么回执都没收到、
  // 第二次却被告知「本来就关着」——正是这条命令要消除的那种歧义。这里就地降级：
  // 记一行错误日志，回执如实说「关是关了，有几样没拆干净」。
  let teardownFailed: boolean = false;
  if (arg === "disable") {
    // teardownChatRuntime 同步清掉的持久字段只有 isProxySendEnabled（见
    // infra/chatTeardown.ts；其余 owner 要么只动进程内状态，要么像 translate 那样
    // 自己落盘）。只清内存的话，重启后代发会话会连同一个已经不再接管的群一起
    // 复活，因此本群此刻真的开着代发会话时要补一次落盘——没开就不写，否则每条
    // /init disable 都白付一次 SQLite 事务加 flush。取值在拆除之前读：
    // clearChatStateField 是 teardownChatRuntime 的第一条语句，拆完就看不出来了。
    const hadProxySend: boolean = state.isProxySendEnabled === true;
    try {
      await teardownChatRuntime(chatId, "explicitDisable");
      // 这一次跟着拆除一起降级——总开关那一次已经 durable，这里只补收尾，失败按
      // 「有几样没拆干净」如实回执，不再扣住 offset 制造上面那种歧义。
      if (hadProxySend) await persistChatState(chatId, "init teardown settled");
    } catch (error: unknown) {
      teardownFailed = true;
      logger.error(
        `Failed to settle the chat runtime teardown for chat ${chatId}; ` +
        "the init gate is already persisted as disabled:",
        error
      );
    }
  }

  // enable 之后立刻把管理员身份重新判定一次。上面的 invalidateBotAdminStatus 刚把
  // 记录作废，这次现查会经 recordBotChatPermissions 回填——「是管理员 && 已初始化」
  // 这个合取若因本次 enable 而成立，那道边沿就在那里触发一次黑名单清扫
  // （见 infra/botAdmin.ts）。不这么做的话，「先给管理员、后 /init enable」这个
  // 最常见的上线顺序永远等不到清扫：管理员那一跳发生时本群还没初始化。
  //
  // 条件挂在「记录此刻是不是空的」上，而不是 !wasEnabled。两者在正常一轮里
  // 完全等价（上面刚把记录作废），区别只在重投那一轮：这次调用**可能上抛**
  // ——getChatMember 之后的状态落盘失败会按 infra/botAdmin.ts 与
  // docs/cn/04-invariants.md 向外传播。进程因此带非零码退出、Telegram 重投这条
  // /init enable 时 wasEnabled 已经是 true；而作废过的权限记录仍是空的，按
  // botPermissions 判定才能继续管理员身份重判与它要触发的黑名单清扫。
  // 记录已知的重复 enable 照旧跳过：那一刻合取没有发生任何变化。
  if (isEnabled && state.botPermissions === undefined) await resolveBotAdminStatus(chatId);

  const replyText: string = teardownFailed
    ? INIT_DISABLE_TEARDOWN_FAILED_TEXT
    : toggleReplyText({
      isEnabled,
      wasEnabled,
      texts: INIT_TOGGLE_TEXTS,
    });
  await sendCommandMessage({ chatId, text: replyText, replyToMessageId: messageId });
}
