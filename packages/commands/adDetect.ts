import { chatAtmosphere } from "../infra/atmosphere";
import type { CommandContext, Context } from "grammy";
import type { ChatState } from "../types/chatState";
import { clearAdDetection } from "../antiRaid";
import { adDetectConfigReadiness } from "../config/readiness";

import { refuseIfConfigBroken } from "./configGate";
import { runChatToggleCommand } from "./superAdminToggle";

/**
 * 处理 /ad_detect enable|disable 指令：按群开关广告检测（见 ChatState.isAdDetectEnabled）。
 * 开启后本群带文字的消息经入群守卫线程送所配 provider 判定，命中即按 /block 同样的处置办：
 * 写进永久黑名单、在所有在管群封禁并删掉这个人发过的消息（见 antiRaid/adDetect.ts）。
 * 仅持有 isCanControllAdDetectPermission 的身份可用；
 * 超级管理员恒持有该权限（见 whitelist.ts），白名单身份可由 /permission 单独获权。
 *
 * 开启前经 adDetectConfigReadiness 检查 config/dynamic/agent.json 的 agent.ad_detect 能力与
 * config/dynamic/ad_samples.json，不可用则拒绝开启；不检查机器人是否为本群管理员。
 *
 * 关闭时经 clearAdDetection 丢掉 Worker 里该群已排队的待检消息；清理是尽力而为，
 * 边界见 runChatToggleCommand。
 */
export async function handleAdDetectCommand(ctx: CommandContext<Context>): Promise<void> {
  await runChatToggleCommand({
    ctx,
    texts: chatAtmosphere().AD_DETECT_TOGGLE_TEXTS,
    permission: "isCanControllAdDetectPermission",
    persistReason: "ad_detect toggled",
    runtimeLabel: "queued ad detection",
    read: (state: ChatState): boolean => state.isAdDetectEnabled === true,
    write: (state: ChatState, isEnabled: boolean): void => {
      state.isAdDetectEnabled = isEnabled;
    },
    refuseEnable: (chatId: number, messageId: number | undefined): Promise<boolean> =>
      refuseIfConfigBroken({
        readiness: adDetectConfigReadiness(),
        chatId,
        messageId,
        feature: "Ad detection",
        text: (file: string): string => chatAtmosphere().NOTICE_TEXTS.adConfigInvalid(file),
      }),
    teardown: clearAdDetection,
  });
}
