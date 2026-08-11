import type { CommandContext, Context } from "grammy";
import type { ChatState } from "../types/chatState";
import { clearAdDetection } from "../antiRaid";
import { adDetectConfigReadiness } from "../config/readiness";
import { AD_DETECT_TOGGLE_TEXTS } from "../consts/commands";
import { refuseIfConfigBroken } from "./configGate";
import { runChatToggleCommand } from "./superAdminToggle";

/**
 * 处理 /ad_detect enable|disable 指令：按群开关广告检测（见
 * ChatState.isAdDetectEnabled，缺省禁用）。开启后本群每条带文字的消息都会经
 * 入群守卫线程送所配 provider 判定，命中即按 /block 同样的处置办——写进永久黑名单、
 * 在所有在管群封禁并删掉这个人发过的消息（见 antiRaid/adDetect.ts）。
 * 仅持有 isCanControllAdDetectPermission 的身份可用；
 * 超级管理员恒持有该权限（见 whitelist.ts），白名单身份可由 /permission 单独获权。
 *
 * 机器人不是本群管理员时判定根本不会触发（删不掉广告也封不了人），开关照样
 * 可以先开着：补上管理员身份之后立刻生效。config/agent.json 的 agent.ad_detect 能力或
 * config/ad_samples.json 写坏则不同——那是判定本身没有凭据/没有口径，开着也
 * 永远不会有结论，因此这里直接拒绝开启，不留一个看着已生效、实际什么都不做
 * 的开关。
 *
 * 关掉之后 Worker 里可能还排着这个群的待检消息串。主线程那道门禁只拦得住之后
 * 的消息，不清队列的话，关掉开关之后还会有人被判成广告拉黑。清理是尽力而为，
 * 边界见 runChatToggleCommand。
 */
export async function handleAdDetectCommand(ctx: CommandContext<Context>): Promise<void> {
  await runChatToggleCommand({
    ctx,
    texts: AD_DETECT_TOGGLE_TEXTS,
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
        text: (file: string): string => `本天才的 ${file} 写坏了，判定口径都读不出来还抓什么广告？修好再重启，笨蛋♡`,
      }),
    teardown: clearAdDetection,
  });
}
