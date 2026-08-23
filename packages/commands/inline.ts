import type { Context } from "grammy";
import { handleGagInlineQuery } from "./gag";
import { handleQaInlineQuery } from "./qa";
import { handleLuckChallengeInlineQuery } from "./luckChallenge";

/**
 * 主线程 inline 查询的唯一业务分发口：`/set_qa` 表单前缀独占应答，其次是对
 * 查询者生效的活动 gag，都不匹配才是运势。三个领域严格互斥，且都只应答一次。
 *
 * qa 排在最前：它的前缀是固定字面量，判定最便宜，且与 gag 前缀互不为前缀。
 */
export async function handleInlineQuery(ctx: Context): Promise<void> {
  if (await handleQaInlineQuery(ctx)) return;
  if (await handleGagInlineQuery(ctx)) return;
  await handleLuckChallengeInlineQuery(ctx);
}
