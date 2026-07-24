import type { CommandContext, Context } from "grammy";
import type { ChatState } from "../types/chatState";
import { getOrCreateChatState, persistAuthoritativeState } from "../infra/storage/stateStore";
import { sendMessage } from "../infra/telegram";
import { resolveSuperAdminToggleArg } from "./superAdminToggle";
import { invalidateBotAdminStatus, teardownChatRuntime } from "../infra/botAdmin";

/**
 * 处理 /init enable|disable 指令：按群开关机器人是否处理这个群的更新（见
 * ChatState.isInitEnabled，缺省未初始化）。禁用/未初始化时，这个群的更新在
 * app/registerHandlers.ts 最前端的网关中间件处直接丢弃，不做任何监听/
 * 复读/AI 相关工作
 * ——仅 SUPER_ADMIN_USER_ID 本人可用，不走 PRIVILEGED_USERS_ID 白名单，与
 * /ai_chat /ja_copy 共用同一批权限。
 */
export async function handleInitCommand(ctx: CommandContext<Context>): Promise<void> {
  const arg = await resolveSuperAdminToggleArg(ctx, {
    rejection: (mockerLabel) => `就 ${mockerLabel} 也想让本天才在这个群干活？哪来的资格呀，笨蛋♡`,
    usage: `笨蛋，要 /init enable 还是 /init disable，说清楚呀♡`,
  });
  if (!arg) return;

  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const state: ChatState = getOrCreateChatState(chatId);
  state.isInitEnabled = arg === "enable";
  invalidateBotAdminStatus(chatId);
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

  const replyText: string = arg === "enable"
    ? `哼，那本天才就大发慈悲开始搭理这个群了，杂鱼们好好珍惜♡`
    : `本天才不想再理这个群了，爱干嘛干嘛去吧♡`;
  await sendMessage({ chatId, text: replyText, replyToMessageId: messageId });
}
