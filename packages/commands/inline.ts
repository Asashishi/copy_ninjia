import type { Context } from "grammy";
import { handleGagInlineQuery } from "./gag";
import { handleLuckChallengeInlineQuery } from "./luckChallenge";

/**
 * 主线程 inline 查询的唯一业务分发口：活动 gag 对查询者生效时优先返回 gag
 * 选项，否则保持原有运势行为。两个 handler 都只通过 grammY Context 应答一次。
 */
export async function handleInlineQuery(ctx: Context): Promise<void> {
  if (await handleGagInlineQuery(ctx)) return;
  await handleLuckChallengeInlineQuery(ctx);
}
