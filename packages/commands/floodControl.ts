import type { CommandContext, Context } from "grammy";
import type { ChatState } from "../types/chatState";
import { clearFloodControl } from "../antiRaid";
import { FLOOD_CONTROL_TOGGLE_TEXTS } from "../consts/commands";
import { logger } from "../infra/logger";
import {
  getOrCreateChatState,
  persistAuthoritativeState,
} from "../infra/storage/stateStore";
import { sendCommandMessage } from "../infra/telegram";
import { resolveSuperAdminToggleArg, toggleReplyText } from "./superAdminToggle";

/**
 * 处理 /flood_control enable|disable 指令：按群开关防刷屏禁言（见
 * ChatState.isFloodControlEnabled，缺省关闭）。仅持有
 * isCanControllFloodControlPermission 的身份可用；超级管理员恒持有该权限
 * （见 config/whitelist.ts），白名单身份可由 /permission 单独获权。
 *
 * 关闭时同步清掉该群在 Worker 里的计数窗口。开关本身已经落盘，这步清理是
 * 尽力而为：Worker 不可用时只记日志、不让异常逃出 handler（同 /ad_detect）。
 */
export async function handleFloodControlCommand(
  ctx: CommandContext<Context>
): Promise<void> {
  const arg: "enable" | "disable" | undefined =
    await resolveSuperAdminToggleArg(ctx, {
      texts: FLOOD_CONTROL_TOGGLE_TEXTS,
      permission: "isCanControllFloodControlPermission",
    });
  if (!arg) return;

  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const state: ChatState = getOrCreateChatState(chatId);
  const wasEnabled: boolean = state.isFloodControlEnabled === true;
  const isEnabled: boolean = arg === "enable";
  state.isFloodControlEnabled = isEnabled;
  await persistAuthoritativeState("flood_control toggled");

  if (arg === "disable") {
    try {
      clearFloodControl(chatId);
    } catch (error: unknown) {
      logger.error(
        `Failed to clear the flood control runtime of chat ${chatId} after disabling it:`,
        error
      );
    }
  }

  const replyText: string = toggleReplyText({
    isEnabled,
    wasEnabled,
    texts: FLOOD_CONTROL_TOGGLE_TEXTS,
  });
  await sendCommandMessage({
    chatId,
    text: replyText,
    replyToMessageId: messageId,
  });
}
