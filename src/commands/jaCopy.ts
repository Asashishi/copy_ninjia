import type { CommandContext, Context } from "grammy";
import type { CachedUser, ChatState } from "../types";
import { getOrCreateChatState, saveState } from "../infra/storage";
import { sendMessage } from "../infra/telegram";
import { handleCopyCommand } from "./copy";
import { resolveSuperAdminToggleArg } from "./superAdminToggle";

/**
 * 处理 /ja_copy 指令：不带参数就是普通的 /copy（复读并翻译成日语，见
 * handleCopyCommand 的 "ja" mode）；带 enable/disable 参数则是原 /ja_trans
 * 的功能——按群开关这个翻译功能本身（见 ChatState.isJATranslationEnabled，
 * 缺省启用）。两种用法共用同一个命令名，靠有没有参数区分。enable/disable
 * 仅 SUPER_ADMIN_USER_ID 本人可用，不走 PRIVILEGED_USERS_ID 白名单——与
 * /ai_chat /init 共用同一批权限。
 */
export async function handleJaCopyCommand(
  ctx: CommandContext<Context>,
  users: Record<string, CachedUser>
): Promise<void> {
  // 只有字面量 enable/disable 才是开关指令；空参数、@username、回复目标等
  // 一律当普通 /ja_copy 处理，转发给 handleCopyCommand 自行解析目标——否则
  // @username 这种非回复的指定目标语法会被误吞进下面的开关分支。
  const arg: string = ctx.match.trim().toLowerCase();
  if (arg !== "enable" && arg !== "disable") {
    await handleCopyCommand(ctx, users, "ja");
    return;
  }

  const toggleArg = await resolveSuperAdminToggleArg(ctx, {
    rejection: (mockerLabel) => `就 ${mockerLabel} 也想管本天才要不要翻译日语？哪来的资格呀，笨蛋♡`,
    usage: `笨蛋，/ja_copy 不带参数是复读翻译，要开关这个功能就 /ja_copy enable 或 /ja_copy disable，说清楚呀♡`,
  });
  if (!toggleArg) return;

  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const state: ChatState = getOrCreateChatState(chatId);
  state.isJATranslationEnabled = toggleArg === "enable";
  await saveState();

  const replyText: string = toggleArg === "enable"
    ? `哼，那本天才就赏脸继续在这个群用 /ja_copy 翻译日语吧，杂鱼们好好珍惜♡`
    : `本天才不想再给你们这群杂鱼翻译日语了，/ja_copy 到此为止♡`;
  await sendMessage(chatId, replyText, messageId);
}
