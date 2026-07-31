import type { Context } from "grammy";
import { getActiveProxySendTarget, getChatState } from "./storage/stateStore";
import { SUPER_ADMIN_USER_ID } from "./config";
import type { Message } from "@grammyjs/types";

/**
 * isInitEnabled 的低成本前置网关，见 app/registerHandlers.ts。未初始化群的
 * 更新在这里被挡下，只放行 my_chat_member、私聊与可首次启用本群的 /init。
 * 私聊是否继续交给命令链由 shouldPassPrivateCommandGate 独立收紧；两道判断在
 * app/registerHandlers.ts 的同一个前置 middleware 中合取。
 * /permission 与 /white 同样位于本中间件之后，只有通过初始化网关才能处理。
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
 * 判断一段消息文本是不是发给当前机器人的 /send 指令本身。这里只校验命令词，
 * 参数仍交给 commands/send.ts；发送者身份由私聊前置网关和 handler 双重校验。
 */
export function isSendCommandText(text: string, botUsername: string): boolean {
  const firstToken: string = (text.split(/\s/, 1)[0] ?? "").toLowerCase();
  return firstToken === "/send" || firstToken === `/send@${botUsername.toLowerCase()}`;
}

/**
 * 私聊指令前置网关，见 app/registerHandlers.ts。私聊里的 / 开头文本一律
 * 拦下，唯一例外是超级管理员发给当前机器人的 /send。该判断与 init 网关在
 * 所有 bot.command / bot.hears 注册之前运行，因此 /permission、/white 也不能
 * 绕过。commands/send.ts 仍保留身份校验，避免未来调用路径绕开本门禁。
 * 判定同时看 text 与 caption：bot.command 只认 text，但 bot.hears（`/咬` 这类
 * 中文动作命令，见 commands/cjkAction.ts）两者都匹配。只看 text 的话，
 * 一张 caption 写着 `/咬` 的图片就能绕过本网关，让任意陌生人在私聊里驱使
 * 机器人作答、并借回复文案的差异探测 username 缓存里有谁。
 * 即使 /send 中转会话正在运行，斜杠开头的内容也不作为中转消息接收，避免它
 * 与真实命令共享一条有歧义的解释路径。
 */
export function shouldPassPrivateCommandGate(ctx: Context): boolean {
  if (ctx.chat?.type !== "private") return true;
  const text: string | undefined = ctx.message?.text ?? ctx.message?.caption;
  if (!text?.startsWith("/")) return true;
  if (typeof ctx.message?.text !== "string") return false;
  return ctx.from?.id === SUPER_ADMIN_USER_ID && isSendCommandText(text, ctx.me.username);
}

/**
 * 活动中的 /send 私聊消息必须在普通命令之前直接交给中转流水线。前置私聊
 * 网关已经拒绝全部斜杠内容，因此这里只路由普通消息；/send 本身仍留给命令
 * 处理器，供超管切换目标或结束会话。
 */
export function shouldRoutePrivateProxyMessage(ctx: Context): boolean {
  if (!ctx.message || ctx.chat?.type !== "private" || ctx.from?.id !== SUPER_ADMIN_USER_ID) return false;
  const text: string | undefined = ctx.message.text ?? ctx.message.caption;
  if (text?.startsWith("/")) return false;
  return getActiveProxySendTarget() !== undefined;
}
