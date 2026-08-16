import type { CommandContext, Context } from "grammy";
import type { ChatState } from "../types/chatState";
import { jaTranslateConfigReadiness } from "../config/readiness";
import { JA_COPY_TOGGLE_TEXTS } from "../consts/commands";
import { getOrCreateChatState, persistChatState } from "../infra/storage/stateStore";
import { sendCommandMessage } from "../infra/telegram";
import { refuseIfConfigBroken } from "./configGate";
import { handleCopyCommand } from "./copy";
import { resolveSuperAdminToggleArg, toggleReplyText } from "./superAdminToggle";

/**
 * 处理 /ja_copy 指令：不带参数就是普通的 /copy（复读并翻译成日语，见
 * handleCopyCommand 的 "ja" mode）；带 enable/disable 参数则按群开关
 * 这个翻译功能本身（见 ChatState.isJATranslationEnabled，
 * 缺省禁用）。两种用法共用同一个命令名，靠有没有参数区分。enable/disable
 * 仅持有 isCanControllJATranslatePermission 的身份可用；
 * 超级管理员恒持有该权限（见 whitelist.ts），白名单身份可由 /permission 单独获权。
 */
export async function handleJaCopyCommand(ctx: CommandContext<Context>): Promise<void> {
  // 只有字面量 enable/disable 才是开关指令；空参数、@username、回复目标等
  // 一律当普通 /ja_copy 处理，转发给 handleCopyCommand 自行解析目标——否则
  // @username 这种非回复的指定目标语法会被误吞进下面的开关分支。
  const arg: string = ctx.match.trim().toLowerCase();
  if (arg !== "enable" && arg !== "disable") {
    await handleCopyCommand(ctx, "ja");
    return;
  }

  const toggleArg: "enable" | "disable" | undefined = await resolveSuperAdminToggleArg(ctx, {
    texts: JA_COPY_TOGGLE_TEXTS,
    permission: "isCanControllJATranslatePermission",
  });
  if (!toggleArg) return;

  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  // 服务账号密钥缺席或写坏时拒绝开启（同 /ai_chat、/ad_detect 的前提判定）：
  // 翻译失败会静默退化成原文照发，群里看不出与「翻译服务抖了一下」的区别，
  // 开着就是一个看着已生效、实际只会复读原文的开关。关闭方向不拦。
  if (toggleArg === "enable") {
    const refused: boolean = await refuseIfConfigBroken({
      readiness: jaTranslateConfigReadiness(),
      chatId,
      messageId,
      feature: "Japanese translation",
      text: (file: string): string => `本天才的 ${file} 不见了或写坏了，拿什么翻日语呀？补好再重启，笨蛋♡`,
    });
    if (refused) return;
  }
  const state: ChatState = getOrCreateChatState(chatId);
  const wasEnabled: boolean = state.isJATranslationEnabled === true;
  const isEnabled: boolean = toggleArg === "enable";
  state.isJATranslationEnabled = isEnabled;
  await persistChatState(chatId, "ja_copy toggled");

  const replyText: string = toggleReplyText({
    isEnabled,
    wasEnabled,
    texts: JA_COPY_TOGGLE_TEXTS,
  });
  await sendCommandMessage({ chatId, text: replyText, replyToMessageId: messageId });
}
