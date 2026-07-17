import type { Context } from "grammy";
import { getActiveProxySendTarget, getChatState } from "./storage";
import { SUPER_ADMIN_USER_ID } from "./config";

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
  // 未初始化群的低成本网关必须在进入 sequentialize/入群守卫之前完成权限
  // 与目标 bot 校验。否则任意用户可用 /init（甚至 /init@OtherBot）反复触发
  // 管理员 API 查询；真正的命令处理器虽会拒绝权限，却已经太晚。
  if (ctx.from?.id !== SUPER_ADMIN_USER_ID) return false;
  const text: string = ctx.message?.text ?? "";
  const firstToken: string = text.split(/\s/, 1)[0]?.toLowerCase() ?? "";
  const ownCommand: string = `/init@${ctx.me.username.toLowerCase()}`;
  if (firstToken === "/init" || firstToken === ownCommand) return true;
  return false;
}

/**
 * 判断一段消息文本是不是 /send 指令本身（含 /send@BotUsername 变体）。只看
 * 命令词本身，不校验参数/权限——那些交给 commands/send.ts 的 handleSendCommand
 * 自己把关。独立导出供 shouldPassPrivateCommandGate 内部使用，也供 bot.command
 * 匹配前的其它判断复用。
 */
export function isSendCommandText(text: string): boolean {
  const firstToken: string = text.split(/\s/, 1)[0] ?? "";
  return firstToken === "/send" || firstToken.startsWith("/send@");
}

/**
 * 私聊指令网关的判断逻辑，从 index.ts 的 bot.use 内联箭头函数里抽出来，纯
 * 是为了能被单测覆盖——行为与原来完全一致，见 index.ts 调用处的完整注释
 * （私聊里的 / 开头文本一律拦下，两处例外：/send 指令本身；有 /send 中转
 * 会话在跑时放行全部消息，好让 handleIncomingMessage 的转发分支收得到）。
 * 会话是否在跑走全局的 getActiveProxySendTarget（不针对某个 chatId 查），
 * 同时必须核对私聊发送者就是超管。机器人可能收到任意用户的私聊更新，不能
 * 因为超管开启了一轮全局会话就把其他用户的命令也放进后续处理器。
 */
export function shouldPassPrivateCommandGate(ctx: Context): boolean {
  const text: string | undefined = ctx.message?.text;
  if (ctx.chat?.type !== "private" || !text?.startsWith("/") || isSendCommandText(text)) {
    return true;
  }
  return ctx.from?.id === SUPER_ADMIN_USER_ID && getActiveProxySendTarget() !== undefined;
}
