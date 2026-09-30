import { chatAtmosphere } from "../infra/atmosphere";
import type {
  CopyCooldownClaim,
  GrantedCopyCooldownClaim,
} from "../types/copy/cooldown";
import {
  claimCopyCooldown,
  getGlobalCopyState,
  persistGlobalState,
  restoreCopyCooldown,
} from "../infra/storage/stateStore";
import { sendCommandMessage } from "../infra/telegram";
import { SUPER_ADMIN_USER_ID } from "../config/bot";
import { COPY_COOLDOWN_MS } from "../consts/commands";
import { formatMinSec } from "../libs/time";

/** copy 类命令（/copy 系与 /icon）共用的全局冷却占用与撤回。 */

/** 冷却检查只读取发起人的 id，用于判定超级管理员豁免。 */
interface CopyCommandUser {
  id: number;
}

/**
 * copy 类命令的公共冷却检查 + 原子占用。全局共享一份 lastCopyTime 冷却时钟
 * （跨所有群共用，不按群分别计时——消耗的是机器人自己头像这一份全局资源）。
 *
 * 检查通过后会在同一个同步执行栈里经 stateStore.ts 的 claimCopyCooldown 占住
 * 冷却槽，中间不经过任何 await。当前 acknowledged runner 全局逐条处理 update，
 * 但这份原子性不能依赖调用入口；若"检查"和"占用"分成两步、中间跨了 await，
 * 两个几乎同时抵达的不同群命令就可能都读到"未冷却"从而一起放行，全局冷却
 * 形同虚设。调用方后续如果发现这次尝试并不会真正触发复制（解析目标失败等），
 * 必须调用 releaseCopyCooldownClaim 撤销占用，否则无效
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
  const lastCopyTime: number | undefined = getGlobalCopyState().lastCopyTime;
  // 只有超级管理员本人免冷却；白名单身份与其他人一样排队。
  const isExempted: boolean = fromUser?.id === SUPER_ADMIN_USER_ID;
  if (!isExempted && lastCopyTime) {
    const elapsed: number = Date.now() - lastCopyTime;
    // 墙钟回拨时 elapsed 为负；把旧时间戳视为已过期，随后本次 claim 会用
    // 当前时钟重建冷却起点，避免额外冻结到时钟追平。
    if (elapsed >= 0 && elapsed < COPY_COOLDOWN_MS) {
      await sendCommandMessage({
        chatId,
        text: chatAtmosphere(chatId).NOTICE_TEXTS.copyCooldown(formatMinSec(COPY_COOLDOWN_MS - elapsed)),
        replyToMessageId: messageId,
      });
      return { rejected: true };
    }
  }

  const claimedAt: number = Date.now();
  const previousLastCopyTime: number | undefined = claimCopyCooldown(claimedAt);
  await persistGlobalState("copy cooldown claimed");
  return { rejected: false, previousLastCopyTime, claimedAt };
}

/**
 * 撤销 claimCopyCooldownOrReject 占用的冷却槽——用于这次尝试最终确认不会
 * 真正触发复制的时候（解析目标失败等），避免无效尝试白白
 * 消耗掉全局冷却。只在冷却槽仍是本次占用写入的值时才回滚：占用与回滚之间
 * 隔着 await（发提示消息等），期间超级管理员（豁免冷却检查）可能已在别的群
 * 成功占用并触发复制，无条件回滚会把 TA 的占用抹掉、让全局冷却凭空消失。
 *
 * 回滚也要落盘：占用那一步已经把 claimedAt 写进了全局状态文件（见
 * claimCopyCooldownOrReject），若这里只回滚内存、不落盘，进程在“占用后已
 * 回滚、但还没被任何其它事件顺带落盘”的这段窗口内重启，状态文件上留着
 * 的仍是那个已作废的 claimedAt——重启后除超级管理员外每个人的下一次 /copy 都
 * 会被这个本不该存在的冷却错误地拒绝，直到它自然过期。
 */
export async function releaseCopyCooldownClaim(
  claim: GrantedCopyCooldownClaim
): Promise<void> {
  if (restoreCopyCooldown(claim.claimedAt, claim.previousLastCopyTime)) {
    await persistGlobalState("copy cooldown released");
  }
}
