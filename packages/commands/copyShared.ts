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
 * copy 类命令的公共冷却检查 + 原子占用。全局共享一份 lastCopyTime 冷却时钟，
 * 跨所有群共用，不按群分别计时。
 *
 * 检查通过后在同一个同步执行栈里经 stateStore.ts 的 claimCopyCooldown 占住冷却槽，
 * 检查与占用之间不经过 await，这份原子性不依赖调用入口。调用方发现这次尝试不会
 * 触发复制（解析目标失败等）时，必须调用 releaseCopyCooldownClaim 撤销占用。
 *
 * 占用之后才等待权威落盘（persistGlobalState）。
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
    // 墙钟回拨时 elapsed 为负：旧时间戳视为已过期，随后本次 claim 用当前时钟重建冷却起点。
    if (elapsed >= 0 && elapsed < COPY_COOLDOWN_MS) {
      await sendCommandMessage({
        chatId,
        text: chatAtmosphere().NOTICE_TEXTS.copyCooldown(formatMinSec(COPY_COOLDOWN_MS - elapsed)),
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
 * 撤销 claimCopyCooldownOrReject 占用的冷却槽，用于这次尝试最终不会触发复制的场合
 * （解析目标失败等）。只在冷却槽仍是本次占用写入的值时才回滚（restoreCopyCooldown 按
 * claimedAt 比对）；发生回滚时同步落盘。
 */
export async function releaseCopyCooldownClaim(
  claim: GrantedCopyCooldownClaim
): Promise<void> {
  if (restoreCopyCooldown(claim.claimedAt, claim.previousLastCopyTime)) {
    await persistGlobalState("copy cooldown released");
  }
}
