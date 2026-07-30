import type { CommandContext, Context } from "grammy";
import type { ChatState } from "../types/chatState";
import { clearAdDetection } from "../antiRaid";
import { adDetectConfigReadiness } from "../config/readiness";
import { AD_DETECT_DEEPSEEK_API_KEY } from "../infra/config";
import { logger } from "../infra/logger";
import { getOrCreateChatState, persistAuthoritativeState } from "../infra/storage/stateStore";
import { sendMessage } from "../infra/telegram";
import { refuseIfConfigBroken } from "./configGate";
import { resolveSuperAdminToggleArg } from "./superAdminToggle";

/**
 * 处理 /ad_detect enable|disable 指令：按群开关广告检测（见
 * ChatState.isAdDetectEnabled，缺省禁用）。开启后本群每条带文字的消息都会经
 * 入群守卫线程送 DeepSeek 判定，命中即按 /block 同样的处置办——写进永久黑名单、
 * 在所有在管群封禁并删掉这个人发过的消息（见 antiRaid/adDetect.ts）。
 * 仅 SUPER_ADMIN_USER_ID 本人可用，与 /ai_chat、/ja_copy、/init 同一批权限。
 *
 * 机器人不是本群管理员时判定根本不会触发（删不掉广告也封不了人），开关照样
 * 可以先开着：补上管理员身份之后立刻生效。缺 AD_DETECT_DEEPSEEK_API_KEY 或
 * config/ad_samples.json 写坏则不同——那是判定本身没有凭据/没有口径，开着也
 * 永远不会有结论，因此这里直接拒绝开启，不留一个看着已生效、实际什么都不做
 * 的开关。两道前提分开报：一个要改 .env，一个要改配置文件，混成一句只会让人
 * 去查错地方。
 */
export async function handleAdDetectCommand(ctx: CommandContext<Context>): Promise<void> {
  const arg: "enable" | "disable" | undefined = await resolveSuperAdminToggleArg(ctx, {
    rejection: (mockerLabel: string): string => `就 ${mockerLabel} 也想管本天才抓不抓广告？哪来的资格呀，笨蛋♡`,
    usage: `笨蛋，要 /ad_detect enable 还是 /ad_detect disable，说清楚呀♡`,
  });
  if (!arg) return;

  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  if (arg === "enable") {
    if (AD_DETECT_DEEPSEEK_API_KEY === undefined) {
      await sendMessage({
        chatId,
        text: `本天才没有 DeepSeek 的 key，拿什么抓广告呀？去 .env 里补上 AD_DETECT_DEEPSEEK_API_KEY 再重启，笨蛋♡`,
        replyToMessageId: messageId,
      });
      return;
    }
    const refused: boolean = await refuseIfConfigBroken({
      readiness: adDetectConfigReadiness(),
      chatId,
      messageId,
      feature: "Ad detection",
      text: (file: string): string => `本天才的 ${file} 写坏了，判定口径都读不出来还抓什么广告？修好再重启，笨蛋♡`,
    });
    if (refused) return;
  }
  const state: ChatState = getOrCreateChatState(chatId);
  state.isAdDetectEnabled = arg === "enable";
  await persistAuthoritativeState("ad_detect toggled");
  // 关掉之后 Worker 里可能还排着这个群的待检消息串。主线程这道门禁只拦得住
  // 之后的消息，不清队列的话，关掉开关之后还会有人被判成广告拉黑。
  //
  // 开关本身已经落盘，运行时清理是尽力而为：Worker 不可用（已放弃/正在重生）时
  // 这里会抛，放它逃出去就是这条 update 判失败、最终 offset 被扣住、重启后
  // Telegram 重投同一条 /ad_detect disable——而 Worker 仍然不可用，重投同样失败，
  // 恰好把重启循环焊死。那两种状态下待检队列本来就随旧 isolate 一起没了，没有
  // 任何东西需要清（同 commands/aiChat.ts 的 invalidateAiChat）。
  if (arg === "disable") {
    try {
      clearAdDetection(chatId);
    } catch (error: unknown) {
      logger.error(`Failed to clear the queued ad detection of chat ${chatId} after disabling it:`, error);
    }
  }

  const replyText: string = arg === "enable"
    ? `哼，本天才这就盯着这个群的广告，敢发的杂鱼一个都别想留下♡`
    : `不抓广告了，随便你们刷吧，本天才可懒得管♡`;
  await sendMessage({ chatId, text: replyText, replyToMessageId: messageId });
}
