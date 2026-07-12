import type { CommandContext, Context } from "grammy";
import type { DeepSeekBalanceResponse } from "../types";
import { sendMessage } from "../infra/telegram";
import { fetchDeepSeekBalance } from "../ai/deepseekBalance";

/** 把 DeepSeek 余额查询结果格式化成人设化的回复文本。 */
function formatBalanceMessage(data: DeepSeekBalanceResponse): string {
  if (data.balance_infos.length === 0) {
    return "哼，账户信息空空如也，杂鱼是不是把本天才的钱包都掏空了♡";
  }

  const lines: string[] = data.balance_infos.map(
    (info) => `${info.currency}：总余额 ${info.total_balance}（充值 ${info.topped_up_balance} + 赠送 ${info.granted_balance}）`
  );
  const availability: string = data.is_available ? "账户状态：可用" : "账户状态：不可用（可能欠费了）";

  return `本天才的 DeepSeek 钱包情况，杂鱼看好了♡\n${lines.join("\n")}\n${availability}`;
}

/**
 * 处理 /balance 指令：查询当前 DeepSeek API Key 绑定账号的余额。查询结果在
 * src/ai/deepseekBalance.ts 里缓存 30 秒，多人连续查也不会把接口打到 429。
 */
export async function handleBalanceCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;

  const data: DeepSeekBalanceResponse | null = await fetchDeepSeekBalance();
  if (!data) {
    await sendMessage(chatId, "呜……查余额失败了，可能是 DeepSeek 那边抽风了，杂鱼待会再试试♡", messageId);
    return;
  }

  await sendMessage(chatId, formatBalanceMessage(data), messageId);
}
