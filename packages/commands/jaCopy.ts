import type { CommandContext, Context } from "grammy";
import type { ChatState } from "../types/chatState";
import { jaTranslateConfigReadiness } from "../config/readiness";
import { JA_COPY_TOGGLE_TEXTS } from "../consts/commands";
import { refuseIfConfigBroken } from "./configGate";
import { handleCopyCommand } from "./copy";
import { runChatToggleCommand } from "./superAdminToggle";

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

  await runChatToggleCommand({
    ctx,
    texts: JA_COPY_TOGGLE_TEXTS,
    permission: "isCanControllJATranslatePermission",
    persistReason: "ja_copy toggled",
    runtimeLabel: "Japanese translation runtime",
    read: (state: ChatState): boolean => state.isJATranslationEnabled === true,
    write: (state: ChatState, isEnabled: boolean): void => {
      state.isJATranslationEnabled = isEnabled;
    },
    refuseEnable: (chatId: number, messageId: number | undefined): Promise<boolean> =>
      refuseIfConfigBroken({
        readiness: jaTranslateConfigReadiness(),
        chatId,
        messageId,
        feature: "Japanese translation",
        text: (file: string): string => `本天才的 ${file} 不见了或写坏了，拿什么翻日语呀？补好再重启，笨蛋♡`,
      }),
  });
}
