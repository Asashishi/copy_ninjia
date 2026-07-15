import type { Context } from "grammy";
import { getChatState } from "./storage";

/**
 * isInit 网关的判断逻辑，从 index.ts 的 bot.use 内联箭头函数里抽出来，纯
 * 是为了能被单测覆盖——行为与原来完全一致，见 index.ts 里调用处的完整注释
 * （未初始化群的更新在这里被挡下，放行 my_chat_member / 私聊 / 指向自己的
 * via_bot 消息 / /init 指令本身）。
 */
export function shouldPassInitGate(ctx: Context): boolean {
  if (ctx.myChatMember) return true;
  if (!ctx.chat || ctx.chat.type === "private") return true;
  if (ctx.msg?.via_bot?.id === ctx.me.id) return true;
  if (getChatState(ctx.chat.id).isInit === true) return true;
  if (/^\/init(@\S+)?(\s|$)/.test(ctx.message?.text ?? "")) return true;
  return false;
}
