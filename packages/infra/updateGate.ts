import type { Context } from "grammy";
import { getActiveProxySendTarget, getChatState } from "./storage/stateStore";
import { SUPER_ADMIN_USER_ID } from "../config/bot";
import type { Chat, Message } from "grammy/types";

/**
 * isInitEnabled 的低成本前置网关，见 app/registerHandlers.ts。未初始化群的
 * 更新在这里被挡下，只放行 my_chat_member、私聊与可首次启用本群的 /init。
 * 私聊是否继续交给命令链由 shouldPassPrivateCommandGate 独立收紧；两道判断在
 * app/registerHandlers.ts 的同一个前置 middleware 中合取。
 * /permission 与 /white 同样位于本中间件之后，只有通过初始化网关才能处理。
 *
 * 指向自己的 via_bot 消息不豁免：运势回执确认位于本网关之前，未初始化群
 * 的 via_bot 更新不进入身份预热、入群守卫和刷屏流水线。下游
 * recordSelfInlineResult 也要求本群已经启用 AI 闲聊。
 */
export function shouldPassInitGate(ctx: Context): boolean {
  if (ctx.myChatMember) return true;
  // `ctx.chat` 是每次求值的 getter 链，这里只读一次；取值放在 myChatMember 判定之后。
  const chat: Chat | undefined = ctx.chat;
  if (!chat || chat.type === "private") return true;
  if (getChatState(chat.id).isInitEnabled === true) return true;
  // 未初始化群在进入身份预热、入群守卫之前完成权限与目标 bot 校验：
  // 只放行超级管理员发给当前机器人的 /init。
  const message: Message | undefined = ctx.msg;
  const actorId: number | undefined =
    message?.sender_chat?.id ??
    (chat.type === "channel" ? chat.id : ctx.from?.id);
  // 身份判定排在字符串处理之前。
  if (actorId !== SUPER_ADMIN_USER_ID) return false;
  return isBotCommandText(message?.text ?? "", "/init", ctx.me.username);
}

/**
 * 文本首词（按空白切分，不区分大小写）是否就是发给当前机器人的 command：裸命令或
 * `command@<当前机器人用户名>`。参数不在这里校验。
 */
export function isBotCommandText(text: string, command: string, botUsername: string): boolean {
  const firstToken: string = (text.split(/\s/, 1)[0] ?? "").toLowerCase();
  return firstToken === command || firstToken === `${command}@${botUsername.toLowerCase()}`;
}

/**
 * 私聊指令前置网关，见 app/registerHandlers.ts。私聊里以 / 开头的文本一律
 * 拦下，唯一例外是超级管理员发给当前机器人的 /send。该判断与 init 网关在
 * 所有 bot.command / bot.hears 注册之前运行，/permission、/white 同样经过。
 * 判定同时看 text 与 caption：bot.command 只认 text，bot.hears（`/咬` 这类
 * 中文动作命令，见 commands/cjkAction.ts）两者都匹配；caption 以 / 开头的
 * 内容一律拦下。/send 中转会话运行期间，斜杠开头的内容也不作为中转消息接收。
 */
export function shouldPassPrivateCommandGate(ctx: Context): boolean {
  if (ctx.chat?.type !== "private") return true;
  const message: Message | undefined = ctx.message;
  const text: string | undefined = message?.text ?? message?.caption;
  if (!text?.startsWith("/")) return true;
  if (typeof message?.text !== "string") return false;
  return ctx.from?.id === SUPER_ADMIN_USER_ID && isBotCommandText(text, "/send", ctx.me.username);
}

/**
 * 活动中的 /send 私聊消息必须在普通命令之前直接交给中转流水线。前置私聊
 * 网关已经拒绝全部斜杠内容，因此这里只路由普通消息；/send 本身仍留给命令
 * 处理器，供超管切换目标或结束会话。
 */
export function shouldRoutePrivateProxyMessage(ctx: Context): boolean {
  const message: Message | undefined = ctx.message;
  if (!message || ctx.chat?.type !== "private" || ctx.from?.id !== SUPER_ADMIN_USER_ID) return false;
  const text: string | undefined = message.text ?? message.caption;
  if (text?.startsWith("/")) return false;
  return getActiveProxySendTarget() !== undefined;
}
