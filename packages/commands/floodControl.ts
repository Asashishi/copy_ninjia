import { chatAtmosphere } from "../infra/atmosphere";
import type { CommandContext, Context } from "grammy";
import type { ChatState } from "../types/chatState";
import { clearFloodControl } from "../antiRaid";

import { runChatToggleCommand } from "./superAdminToggle";

/**
 * 处理 /flood_control enable|disable 指令：按群开关防刷屏禁言（见 ChatState.isFloodControlEnabled）。
 * 仅持有 isCanControllFloodControlPermission 的身份可用；超级管理员恒持有该权限
 * （见 whitelist.ts），白名单身份可由 /permission 单独获权。
 *
 * 关闭时经 clearFloodControl 清掉该群在 Worker 里的发言窗口；清理在落盘之后，
 * 是尽力而为，边界见 runChatToggleCommand。
 */
export async function handleFloodControlCommand(
  ctx: CommandContext<Context>
): Promise<void> {
  await runChatToggleCommand({
    ctx,
    texts: chatAtmosphere().FLOOD_CONTROL_TOGGLE_TEXTS,
    permission: "isCanControllFloodControlPermission",
    persistReason: "flood_control toggled",
    runtimeLabel: "flood control runtime",
    read: (state: ChatState): boolean => state.isFloodControlEnabled === true,
    write: (state: ChatState, isEnabled: boolean): void => {
      state.isFloodControlEnabled = isEnabled;
    },
    teardown: clearFloodControl,
  });
}
