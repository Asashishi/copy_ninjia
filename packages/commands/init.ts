import type { CommandContext, Context } from "grammy";
import type { ChatState } from "../types/chatState";
import { getOrCreateChatState, persistAuthoritativeState } from "../infra/storage/stateStore";
import { sendCommandMessage } from "../infra/telegram";
import { resolveSuperAdminToggleArg } from "./superAdminToggle";
import { invalidateBotAdminStatus, isBotAdminIn, teardownChatRuntime } from "../infra/botAdmin";

/**
 * 处理 /init enable|disable 指令：按群开关机器人是否处理这个群的更新（见
 * ChatState.isInitEnabled，缺省未初始化）。禁用/未初始化时，这个群的更新在
 * app/registerHandlers.ts 最前端的网关中间件处直接丢弃，不做任何监听/
 * 复读/AI 相关工作
 * ——只有超级管理员可以控制这个总开关。
 */
export async function handleInitCommand(ctx: CommandContext<Context>): Promise<void> {
  const arg: "enable" | "disable" | undefined = await resolveSuperAdminToggleArg(ctx, {
    rejection: (mockerLabel: string): string => `就 ${mockerLabel} 也想让本天才在这个群干活？哪来的资格呀，笨蛋♡`,
    usage: `笨蛋，要 /init enable 还是 /init disable，说清楚呀♡`,
  });
  if (!arg) return;

  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const state: ChatState = getOrCreateChatState(chatId);
  const wasEnabled: boolean = state.isInitEnabled === true;
  const isEnabled: boolean = arg === "enable";
  state.isInitEnabled = isEnabled;
  // 唯一不作废的情形：对已经启用的群重复 /init enable。那是一次空操作，若
  // 照样作废，随后的重新判定会让 recordBotAdminStatus 看到 undefined -> true，
  // 被当成一次全新的边沿，把整份黑名单再清扫一遍（名单几百条时就是几百次
  // getChatMember 压进验证队列）。disable 一律作废——关掉之后这份权限记录
  // 本来就不该继续被信任。
  if (!(isEnabled && wasEnabled)) invalidateBotAdminStatus(chatId);
  const teardownResults: PromiseSettledResult<void>[] = arg === "disable"
    ? await Promise.allSettled([teardownChatRuntime(chatId)])
    : [];
  // disable 即使拆运行态失败也必须先落盘，确保重启后网关仍保持关闭；错误会在
  // 持久化完成后继续上抛，因此不会发送成功提示或确认这条 update。
  const persistenceResults: PromiseSettledResult<void>[] = await Promise.allSettled([
    persistAuthoritativeState("init toggled"),
  ]);
  const failures: unknown[] = [...teardownResults, ...persistenceResults].flatMap(
    (result: PromiseSettledResult<void>): unknown[] => result.status === "rejected" ? [result.reason] : []
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `Failed to disable and persist chat ${chatId}.`);
  }

  // enable 之后立刻把管理员身份重新判定一次。上面的 invalidateBotAdminStatus 刚把
  // 记录作废，这次现查会经 recordBotAdminStatus 回填——「是管理员 && 已初始化」
  // 这个合取若因本次 enable 而成立，那道边沿就在那里触发一次黑名单清扫
  // （见 infra/botAdmin.ts）。不这么做的话，「先给管理员、后 /init enable」这个
  // 最常见的上线顺序永远等不到清扫：管理员那一跳发生时本群还没初始化。
  // isBotAdminIn 自己吞掉所有错误（失败按非管理员处理），不会影响本命令成败。
  // 已经是 enable 的群不重判：上面没作废记录，这里查也只会拿到同一个值。
  if (isEnabled && !wasEnabled) await isBotAdminIn(chatId);

  const replyText: string = arg === "enable"
    ? `哼，那本天才就大发慈悲开始搭理这个群了，杂鱼们好好珍惜♡`
    : `本天才不想再理这个群了，爱干嘛干嘛去吧♡`;
  await sendCommandMessage({ chatId, text: replyText, replyToMessageId: messageId });
}
