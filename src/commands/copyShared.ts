import { logger } from "../infra/logger";
import type { CommandContext, Context } from "grammy";
import type { CachedUser } from "../types";
import { getGlobalCopyState } from "../infra/storage";
import { sendMessage, copyUserProfilePhoto } from "../infra/telegram";
import { PRIVILEGED_USERS_ID } from "../infra/config";
import { COPY_COOLDOWN_MS } from "../consts/commands";
import { formatMinSec } from "../libs/time";
import { resolveCommandTarget } from "./targetResolution";

/**
 * copy 类命令（/copy 系与 /steal_icon）的公共零件：共享冷却检查、
 * 目标解析（回复消息优先于 @username 参数）、后台偷头像任务。
 */

/** claimCopyCooldownOrReject 的返回值：拒绝时只有 rejected；放行时附带占用前
 * 的旧时间戳与本次占用写入的时间戳，供调用方在这次尝试最终没有真正开始复制时
 * 用 releaseCopyCooldownClaim 回滚。 */
type CopyCooldownClaim = { rejected: true } | { rejected: false; previousLastCopyTime: number | undefined; claimedAt: number };

/**
 * copy 类命令的公共冷却检查 + 原子占用。全局共享一份 lastCopyTime 冷却时钟
 * （跨所有群，不再按群分别计时——消耗的是机器人自己头像这一份全局资源）。
 *
 * 检查通过后会在同一个同步执行栈里立刻写入 globalCopyState.lastCopyTime 占住
 * 冷却槽，中间不经过任何 await：grammY 按群并发处理更新（不同群互不排队，见
 * index.ts 的 sequentialize），若"检查"和"占用"分成两步、中间跨了 await，
 * 两个几乎同时抵达的不同群命令就可能都读到"未冷却"从而一起放行，全局冷却
 * 形同虚设。调用方后续如果发现这次尝试并不会真正触发复制（解析目标失败、
 * 已经在复读别人等），必须调用 releaseCopyCooldownClaim 撤销占用，否则无效
 * 尝试也会白白消耗掉全局冷却，殃及所有群。
 * @returns rejected 为 true 时提示已发送，调用方应直接返回；否则调用方可以
 * 继续，并需要在放弃这次尝试时把返回值传给 releaseCopyCooldownClaim 回滚。
 */
export async function claimCopyCooldownOrReject(
  fromUser: { id: number } | undefined,
  chatId: number,
  messageId: number | undefined
): Promise<CopyCooldownClaim> {
  const globalCopyState = getGlobalCopyState();
  const isExempted: boolean = !!fromUser && PRIVILEGED_USERS_ID.includes(fromUser.id);
  if (!isExempted && globalCopyState.lastCopyTime) {
    const elapsed: number = Date.now() - globalCopyState.lastCopyTime;
    if (elapsed < COPY_COOLDOWN_MS) {
      await sendMessage(chatId, `急什么呀笨蛋，还要等 ${formatMinSec(COPY_COOLDOWN_MS - elapsed)} 才能用 copy 类命令哦，乖乖等着吧♡`, messageId);
      return { rejected: true };
    }
  }

  const previousLastCopyTime: number | undefined = globalCopyState.lastCopyTime;
  const claimedAt: number = Date.now();
  globalCopyState.lastCopyTime = claimedAt;
  return { rejected: false, previousLastCopyTime, claimedAt };
}

/**
 * 撤销 claimCopyCooldownOrReject 占用的冷却槽——用于这次尝试最终确认不会
 * 真正触发复制的时候（解析目标失败、已经在复读别人等），避免无效尝试白白
 * 消耗掉全局冷却。只在冷却槽仍是本次占用写入的值时才回滚：占用与回滚之间
 * 隔着 await（发提示消息等），期间白名单用户（豁免冷却检查）可能已在别的群
 * 成功占用并触发复制，无条件回滚会把 TA 的占用抹掉、让全局冷却凭空消失。
 */
export function releaseCopyCooldownClaim(claim: { previousLastCopyTime: number | undefined; claimedAt: number }): void {
  const globalCopyState = getGlobalCopyState();
  if (globalCopyState.lastCopyTime === claim.claimedAt) {
    globalCopyState.lastCopyTime = claim.previousLastCopyTime;
  }
}

/**
 * copy 类命令的目标解析，见 targetResolution.ts 的 resolveCommandTarget（回复
 * 优先于 @username）。解析失败（没给目标、@username 没缓存、目标是机器人
 * 自己）时反馈已发送。
 * @param commandName 触发的命令名（如 "/copy"、"/steal_icon"），用于错误提示文案。
 * @returns 解析出的目标；失败时为 undefined（提示已发送，调用方应直接返回）。
 */
export async function resolveCopyCommandTarget(
  ctx: CommandContext<Context>,
  users: Record<string, CachedUser>,
  commandName: string
): Promise<CachedUser | undefined> {
  return resolveCommandTarget(ctx, users, {
    missingTarget: `笨蛋，要么 ${commandName} @username，要么直接回复 TA 的一条消息再 ${commandName}，本天才总得知道杂鱼是谁吧♡`,
    unknownUsername: (rawUsername: string) =>
      `笨蛋，@${rawUsername} 都还没说过话呢，本天才要怎么记住这种杂鱼呀，先让 TA 冒个泡，或者直接回复 TA 的消息来 ${commandName} 呀♡`,
    selfTarget: `笨蛋，本天才怎么可能盯上自己呀♡`,
  });
}

/**
 * 在后台把目标的头像偷来设为机器人自己的头像，完成后按结果发送战报。
 * 不阻塞主消息处理：即使头像抓取失败或耗时很久，也不会卡住调用方的后续
 * 逻辑（比如 /copy 的复读已经生效）。
 * @param successText 头像更换成功时发送的文本。
 * @param failureText 头像更换失败时发送的文本。
 */
export function stealAvatarInBackground(chatId: number, target: CachedUser, successText: string, failureText: string): void {
  void (async (): Promise<void> => {
    const photoUpdated: boolean = await copyUserProfilePhoto(target.id, !!target.isChannel, target.username);
    await sendMessage(chatId, photoUpdated ? successText : failureText);
  })().catch((error: unknown) => {
    logger.error("Error in background avatar steal task:", error);
  });
}
