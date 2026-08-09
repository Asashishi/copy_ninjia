import type { Context } from "grammy";
import { handleGagInlineQuery } from "./gag";
import { handleLuckChallengeInlineQuery } from "./luckChallenge";

/**
 * 主线程 inline 查询的唯一业务分发口：活动 gag 对查询者生效时独占应答，
 * 非 gag 查询者保持运势行为。两个领域严格互斥，且都只应答一次。
 */
export async function handleInlineQuery(ctx: Context): Promise<void> {
  if (await handleGagInlineQuery(ctx)) return;
  await handleLuckChallengeInlineQuery(ctx);
}
