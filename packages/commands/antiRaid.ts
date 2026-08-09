import type { CommandContext, Context } from "grammy";
import type { ChatState } from "../types/chatState";
import { deactivateJoinGuardChat } from "../antiRaid";
import {
  ANTI_RAID_DISABLE_TEARDOWN_FAILED_TEXT,
  ANTI_RAID_TOGGLE_TEXTS,
} from "../consts/commands";
import { logger } from "../infra/logger";
import {
  getOrCreateChatState,
  persistAuthoritativeState,
} from "../infra/storage/stateStore";
import { sendCommandMessage } from "../infra/telegram";
import { resolveSuperAdminToggleArg, toggleReplyText } from "./superAdminToggle";

/**
 * 处理 /antiraid enable|disable 指令：按群开关入群守卫（见
 * ChatState.isAntiRaidEnabled，缺省关闭）。仅持有
 * isCanControllAntiRaidPermission 的身份可用；超级管理员恒持有该权限
 * （见 config/whitelist.ts），白名单身份可由 /permission 单独获权。
 *
 * 这一个开关同时管**两条链路**：入群验证（按钮 + 提醒 + 超时踢出）和防冲群
 * 私密模式（短时间大量入群时关闭邀请权限）。它们共用同一批入群事件，拆成两个
 * 开关只会造出「验证关着、私密模式还在踢人」这种没人预期的组合。
 *
 * 同在 Anti-Raid Worker 里跑的广告检测（/ad_detect）、防刷屏禁言
 * （/flood_control）和永久黑名单**不受影响**：各有各的边界，见
 * types/antiRaid.ts 的 DeactivateJoinGuardMessage。
 *
 * 关闭时把这个群已经开着的验证窗口和仍生效的私密模式一并收掉（后者会恢复
 * 邀请权限——开关都关了，没人再会解开它）。与 /ad_detect 那条尽力而为的清理
 * 不同，这里的失败必须如实回执：验证窗口活在主线程镜像里，Worker 重建后会被
 * adopt 重放回去，管理员得知道「还没拆干净」并再关一次（adopt 那一侧另有
 * purgeDisabledJoinGuards 兜底，见 antiRaid/workerBridge.ts）。异常照旧不外抛
 * ——开关已经落盘，让它逃出 handler 只会扣住 offset 并让 Telegram 重投同一条
 * 命令，而那时 wasEnabled 已经是 false（同 commands/init.ts）。
 */
export async function handleAntiRaidCommand(
  ctx: CommandContext<Context>
): Promise<void> {
  const arg: "enable" | "disable" | undefined =
    await resolveSuperAdminToggleArg(ctx, {
      texts: ANTI_RAID_TOGGLE_TEXTS,
      permission: "isCanControllAntiRaidPermission",
    });
  if (!arg) return;

  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const state: ChatState = getOrCreateChatState(chatId);
  const wasEnabled: boolean = state.isAntiRaidEnabled === true;
  const isEnabled: boolean = arg === "enable";
  state.isAntiRaidEnabled = isEnabled;
  // 落盘失败原样上抛：那是 fatal durability failure，这条 update 不能被确认
  // （见 docs/cn/04-invariants.md）。
  await persistAuthoritativeState("antiraid toggled");

  let teardownFailed: boolean = false;
  if (!isEnabled) {
    try {
      deactivateJoinGuardChat(chatId);
    } catch (error: unknown) {
      teardownFailed = true;
      logger.error(
        `Failed to tear down the join guard runtime of chat ${chatId}; ` +
        "the switch is already persisted as disabled:",
        error
      );
    }
  }

  const replyText: string = teardownFailed
    ? ANTI_RAID_DISABLE_TEARDOWN_FAILED_TEXT
    : toggleReplyText({
      isEnabled,
      wasEnabled,
      texts: ANTI_RAID_TOGGLE_TEXTS,
    });
  await sendCommandMessage({
    chatId,
    text: replyText,
    replyToMessageId: messageId,
  });
}
