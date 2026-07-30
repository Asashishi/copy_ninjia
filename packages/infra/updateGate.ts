import type { Context } from "grammy";
import { getActiveProxySendTarget, getChatState } from "./storage/stateStore";
import { SUPER_ADMIN_USER_ID } from "./config";
import type { Message } from "@grammyjs/types";

/**
 * isInitEnabled 的低成本前置网关，见 app/registerHandlers.ts。未初始化群的
 * 更新在这里被挡下，只放行 my_chat_member、私聊与可首次启用本群的 /init。
 * /permission 与 /white 作为全局授权入口，已经在本中间件之前完成匹配与处理。
 *
 * 指向自己的 via_bot 消息**不**豁免。曾经有过这么一条，理由是「否则运势回执
 * 够不到 confirmLuckDraw」，但那个前提早就不成立了：回执是 registerHandlers.ts
 * 里排在本网关**之前**的一道 bot.use，转发副本也要认，从来不经过这里。留着它
 * 只对「从没 /init enable 过」的群有效果（已启用的群下一行本来就放行），而
 * inline 模式是公开的——任何人 `@bot <query>` 选一条结果，就能让这条更新进
 * sequentialize、入群守卫和刷屏流水线，每条都换一次没有缓存的 getChatMember
 * （recordBotAdminStatus 对未初始化的群不落盘，见 infra/botAdmin.ts），频率由
 * 对方控制。收益是零：唯一的下游 recordSelfInlineResult 要求本群开着 AI 闲聊，
 * 而 /ai_chat enable 本身就在网关之后。
 */
export function shouldPassInitGate(ctx: Context): boolean {
  if (ctx.myChatMember) return true;
  if (!ctx.chat || ctx.chat.type === "private") return true;
  if (getChatState(ctx.chat.id).isInitEnabled === true) return true;
  // 未初始化群的低成本网关必须在进入 sequentialize/入群守卫之前完成权限
  // 与目标 bot 校验。否则任意用户可用 /init（甚至 /init@OtherBot）反复触发
  // 管理员 API 查询；真正的命令处理器虽会拒绝权限，却已经太晚。
  const message: Message | undefined = ctx.msg ?? ctx.message;
  const actorId: number | undefined =
    message?.sender_chat?.id ??
    (ctx.chat.type === "channel" ? ctx.chat.id : ctx.from?.id);
  const text: string = message?.text ?? "";
  const firstToken: string = text.split(/\s/, 1)[0]?.toLowerCase() ?? "";
  const botUsername: string = ctx.me.username.toLowerCase();
  if (actorId !== SUPER_ADMIN_USER_ID) return false;
  const ownCommand: string = `/init@${botUsername}`;
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
 * 私聊指令前置网关，见 app/registerHandlers.ts。私聊里的 / 开头文本一律
 * 拦下，两处例外：/send 指令本身；有 /send 中转会话在跑时放行全部消息，
 * 好让 handleIncomingMessage 的转发分支收得到。全局 /permission 与 /white
 * 已经在本网关之前匹配，不属于这里的例外。
 * 判定同时看 text 与 caption：bot.command 只认 text，但 bot.hears（`/咬` 这类
 * 中文动作命令，见 commands/cjkAction.ts）两者都匹配。只看 text 的话，
 * 一张 caption 写着 `/咬` 的图片就能绕过本网关，让任意陌生人在私聊里驱使
 * 机器人作答、并借回复文案的差异探测 username 缓存里有谁。
 * 会话是否在跑走全局的 getActiveProxySendTarget（不针对某个 chatId 查），
 * 同时必须核对私聊发送者就是超管。机器人可能收到任意用户的私聊更新，不能
 * 因为超管开启了一轮全局会话就把其他用户的命令也放进后续处理器。
 */
export function shouldPassPrivateCommandGate(ctx: Context): boolean {
  const text: string | undefined = ctx.message?.text ?? ctx.message?.caption;
  if (ctx.chat?.type !== "private" || !text?.startsWith("/") || isSendCommandText(text)) {
    return true;
  }
  return ctx.from?.id === SUPER_ADMIN_USER_ID && getActiveProxySendTarget() !== undefined;
}

/**
 * 活动中的 /send 私聊消息必须在普通命令之前直接交给中转流水线。否则消息
 * 恰好以 /copy、/block 等命令开头时，会先被 grammY 截获并真的执行，而不是
 * 作为消息内容转发。/permission 与 /white 都刻意放在中转之前；/send 本身
 * 仍留给命令处理器，供超管切换目标或结束会话。
 */
export function shouldRoutePrivateProxyMessage(ctx: Context): boolean {
  if (!ctx.message || ctx.chat?.type !== "private" || ctx.from?.id !== SUPER_ADMIN_USER_ID) return false;
  if (typeof ctx.message.text === "string" && isSendCommandText(ctx.message.text)) {
    return false;
  }
  return getActiveProxySendTarget() !== undefined;
}
