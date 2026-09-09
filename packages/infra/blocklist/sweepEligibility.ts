/**
 * 黑名单补扫的资格判定：这个群受不受管、它的 claim 槽位此刻空不空。
 *
 * 只做纯判定，不读缓存也不投递，因此 `sweep.ts`、`sweepScheduler.ts`、
 * `sweepRetryState.ts` 与 `outbox.ts` 都能直接依赖它而不形成环（调度器与补扫
 * 状态机之间那条「执行函数由 sweep.ts 注入」的边界仍然成立）。
 *
 * 四个消费方读的必须是同一份判据：`prepareBlocklistSweep` 用它决定建不建
 * claim、`sweepBlockedMembers` 用它决定付不付那次跨线程名单页读、
 * `nextBlocklistSweepAt` 用它挑该排 timer 的群、`hydrateBlocklist` 用它筛恢复出的
 * 任务。抄开的话，哪天改了兜底语义（例如把 permissionBlocked 也算成可 claim）
 * 只会改到一处，几条路径从此对「这个群该不该扫」各执一词。
 * @see ../../../docs/cn/04-invariants.md
 */

import type { BlocklistSweepRecord } from "../../types/blocklist";
import type { ChatState } from "../../types/chatState";

/**
 * 这个群是不是「已 `/init enable` 且已确证机器人是管理员」的受管群。
 *
 * 两项都要确证：`botPermissions` 缺省表示「还没查过」，按 fail-closed 不算受管
 * （见 infra/botAdmin.ts 的三态口径）。没有条目的群同样不受管。
 */
export function isManagedAdminChat(chatState: ChatState | undefined): boolean {
  return chatState?.isInitEnabled === true &&
    chatState.botPermissions?.isAdministrator === true;
}

/**
 * claim 槽位此刻空不空：上一轮已经扫完（`sweptAt`）、仍有在途任务
 * （`removalId`）、或被缺封禁权限闩住（`permissionBlocked`）时都不空。
 *
 * **不含退避时间判定**：调度器要在这一档之上再读 `nextRetryAt` 排 timer，
 * 那一步问的是「什么时候能扫」而不是「能不能扫」。
 */
export function isSweepSlotFree(progress: BlocklistSweepRecord): boolean {
  return progress.sweptAt === null &&
    progress.removalId === null &&
    !progress.permissionBlocked;
}

/**
 * 这个群此刻能不能建立一条新的补扫 claim。
 *
 * 从没扫过（无记录）的群一律可以；有记录时要求槽位空闲且已过退避截止。
 * @param now 判定用的当前时刻；调用方按各自路径传入同一个 now。
 */
export function canClaimSweep(
  progress: BlocklistSweepRecord | undefined,
  now: number
): boolean {
  return progress === undefined ||
    (isSweepSlotFree(progress) && now >= progress.nextRetryAt);
}
