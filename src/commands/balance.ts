import type { CommandContext, Context } from "grammy";
import { sendMessage } from "../infra/telegram";

/**
 * 处理 /balance 指令。AI 后端已从 DeepSeek 迁到 xAI（Grok），而 xAI 没有
 * 面向推理 API key 的余额查询接口（账单只能在 console.x.ai 控制台看），
 * 原来的实时余额查询做不了了：保留命令入口，固定回复一句说明，免得老
 * 用户敲了没反应以为机器人坏了。哪天 xAI 开放余额 API 再把查询接回来。
 */
export async function handleBalanceCommand(ctx: CommandContext<Context>): Promise<void> {
  await sendMessage(
    ctx.chat.id,
    "本天才已经改用 Grok 大脑啦，xAI 不给查余额的接口，钱包情况只有主人去 console.x.ai 亲自看，杂鱼就别惦记本天才的钱包了♡",
    ctx.msgId
  );
}
