import type { CommandContext, Context } from "grammy";
import type { CachedUser, GlobalCopyState } from "../types/chatState";
import type { CommandTargetMessages } from "../types/commands";
import type {
  CopyCooldownClaim,
  GrantedCopyCooldownClaim,
} from "../types/copy/cooldown";
import { getGlobalCopyState, persistAuthoritativeState } from "../infra/storage/stateStore";
import { sendCommandMessage } from "../infra/telegram";
import { isWhitelisted } from "../config/whitelist";
import { COPY_COOLDOWN_MS } from "../consts/commands";
import { formatMinSec } from "../libs/time";
import { queueAvatarUpdate } from "../copy/avatarQueue";
import { resolveCommandTarget } from "./targetResolution";

/**
 * copy 类命令（/copy 系与 /steal_icon）的公共零件：共享冷却检查、
 * 目标解析（回复消息优先于 @username 参数）、后台偷头像任务。
 */

/** claimCopyCooldownOrReject 的返回值：拒绝时只有 rejected；放行时附带占用前
 * 的旧时间戳与本次占用写入的时间戳，供调用方在这次尝试最终没有真正开始复制时
 * 用 releaseCopyCooldownClaim 回滚。 */
interface CopyCommandUser {
  id: number;
}

/**
 * copy 类命令的公共冷却检查 + 原子占用。全局共享一份 lastCopyTime 冷却时钟
 * （跨所有群，不再按群分别计时——消耗的是机器人自己头像这一份全局资源）。
 *
 * 检查通过后会在同一个同步执行栈里立刻写入 globalCopyState.lastCopyTime 占住
 * 冷却槽，中间不经过任何 await：grammY 按群并发处理更新（不同群互不排队，见
 * app/registerHandlers.ts 的 sequentialize），若"检查"和"占用"分成两步、
 * 中间跨了 await，
 * 两个几乎同时抵达的不同群命令就可能都读到"未冷却"从而一起放行，全局冷却
 * 形同虚设。调用方后续如果发现这次尝试并不会真正触发复制（解析目标失败、
 * 已经在复读别人等），必须调用 releaseCopyCooldownClaim 撤销占用，否则无效
 * 尝试也会白白消耗掉全局冷却，殃及所有群。
 *
 * 占用在同步栈内完成后等待权威落盘；await 发生在写入之后，不影响上面的
 * 原子占位不变量。若只在真正开始复读时才落盘，冷却时钟在
 * "已认领但还没真正开始复读"的短窗口内只活在内存里，此时崩溃重启会让
 * 冷却被重置，刚好卡在这个窗口发起的下一次尝试就能绕开冷却限制。
 * @returns rejected 为 true 时提示已发送，调用方应直接返回；否则调用方可以
 * 继续，并需要在放弃这次尝试时把返回值传给 releaseCopyCooldownClaim 回滚。
 */
export async function claimCopyCooldownOrReject(
  fromUser: CopyCommandUser | undefined,
  chatId: number,
  messageId: number | undefined
): Promise<CopyCooldownClaim> {
  const globalCopyState: GlobalCopyState = getGlobalCopyState();
  const isExempted: boolean = !!fromUser && isWhitelisted(fromUser.id);
  if (!isExempted && globalCopyState.lastCopyTime) {
    const elapsed: number = Date.now() - globalCopyState.lastCopyTime;
    // 墙钟回拨时 elapsed 为负；把旧时间戳视为已过期，随后本次 claim 会用
    // 当前时钟重建冷却起点，避免额外冻结到时钟追平。
    if (elapsed >= 0 && elapsed < COPY_COOLDOWN_MS) {
      await sendCommandMessage({
        chatId,
        text: `急什么呀笨蛋，还要等 ${formatMinSec(COPY_COOLDOWN_MS - elapsed)} 才能用 copy 类命令哦，乖乖等着吧♡`,
        replyToMessageId: messageId,
      });
      return { rejected: true };
    }
  }

  const previousLastCopyTime: number | undefined = globalCopyState.lastCopyTime;
  const claimedAt: number = Date.now();
  globalCopyState.lastCopyTime = claimedAt;
  await persistAuthoritativeState("copy cooldown claimed");
  return { rejected: false, previousLastCopyTime, claimedAt };
}

/**
 * 撤销 claimCopyCooldownOrReject 占用的冷却槽——用于这次尝试最终确认不会
 * 真正触发复制的时候（解析目标失败、已经在复读别人等），避免无效尝试白白
 * 消耗掉全局冷却。只在冷却槽仍是本次占用写入的值时才回滚：占用与回滚之间
 * 隔着 await（发提示消息等），期间白名单用户（豁免冷却检查）可能已在别的群
 * 成功占用并触发复制，无条件回滚会把 TA 的占用抹掉、让全局冷却凭空消失。
 *
 * 回滚也要落盘：占用那一步已经把 claimedAt 写进了 state.json（见
 * claimCopyCooldownOrReject），若这里只回滚内存、不落盘，进程在“占用后已
 * 回滚、但还没被任何其它事件顺带落盘”的这段窗口内重启，state.json 上留着
 * 的仍是那个已作废的 claimedAt——重启后每个非白名单用户的下一次 /copy 都
 * 会被这个本不该存在的冷却错误地拒绝，直到它自然过期。
 */
export async function releaseCopyCooldownClaim(
  claim: GrantedCopyCooldownClaim
): Promise<void> {
  const globalCopyState: GlobalCopyState = getGlobalCopyState();
  if (globalCopyState.lastCopyTime === claim.claimedAt) {
    globalCopyState.lastCopyTime = claim.previousLastCopyTime;
    await persistAuthoritativeState("copy cooldown released");
  }
}

/**
 * copy 类命令的目标解析，见 targetResolution.ts 的 resolveCommandTarget（回复
 * 优先于 @username）。解析失败（没给目标、@username 没缓存、目标是机器人
 * 自己）时反馈已发送。
 * @param messages 触发命令自己的目标解析文案表（见 consts/commands.ts）。
 * @returns 解析出的目标；失败时为 undefined（提示已发送，调用方应直接返回）。
 */
export async function resolveCopyCommandTarget(
  ctx: CommandContext<Context>,
  messages: CommandTargetMessages
): Promise<CachedUser | undefined> {
  return resolveCommandTarget({
    chatId: ctx.chat.id,
    message: ctx.msg,
    botUserId: ctx.me.id,
    rawArgument: ctx.match,
    messages,
  });
}

/** stealAvatarInBackground 的入参。 */
export interface StealAvatarInBackgroundParams {
  chatId: number;
  target: CachedUser;
  /** 头像更换成功时发送的文本。 */
  successText: string;
  /** 头像更换失败时发送的文本。 */
  failureText: string;
}

/**
 * 在后台把目标的头像偷来设为机器人自己的头像，完成后按结果发送战报。
 * 不阻塞主消息处理：即使头像抓取失败或耗时很久，也不会卡住调用方的后续
 * 逻辑（比如 /copy 的复读已经生效）。
 */
export function stealAvatarInBackground({
  chatId,
  target,
  successText,
  failureText,
}: StealAvatarInBackgroundParams): void {
  queueAvatarUpdate({ chatId, target, successText, failureText });
}
