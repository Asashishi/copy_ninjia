import type { CommandContext, Context } from "grammy";
import type { ChatState } from "../types/chatState";
import { clearFloodControl } from "../antiRaid";
import { logger } from "../infra/logger";
import {
  getOrCreateChatState,
  persistAuthoritativeState,
} from "../infra/storage/stateStore";
import { sendCommandMessage } from "../infra/telegram";
import { resolveSuperAdminToggleArg } from "./superAdminToggle";

/** 按群开关防刷屏禁言；缺省关闭。 */
export async function handleFloodControlCommand(
  ctx: CommandContext<Context>
): Promise<void> {
  const arg: "enable" | "disable" | undefined =
    await resolveSuperAdminToggleArg(ctx, {
      rejection: (mockerLabel: string): string =>
        `就 ${mockerLabel} 也想管本天才抓不抓刷屏？哪来的资格呀，笨蛋♡`,
      usage: `笨蛋，要 /flood_control enable 还是 /flood_control disable，说清楚呀♡`,
      permission: "isCanControllFloodControlPermission",
    });
  if (!arg) return;

  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const state: ChatState = getOrCreateChatState(chatId);
  state.isFloodControlEnabled = arg === "enable";
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

  const replyText: string = arg === "enable"
    ? `哼，本天才开始盯着这个群的刷屏杂鱼了，刷太快就等着被按住吧♡`
    : `防刷屏关掉了，随便你们吵吧，本天才懒得管♡`;
  await sendCommandMessage({
    chatId,
    text: replyText,
    replyToMessageId: messageId,
  });
}
