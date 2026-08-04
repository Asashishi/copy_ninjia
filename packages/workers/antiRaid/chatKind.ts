/**
 * 群类型在入群守卫线程侧的读写口。
 *
 * 观测发生在主线程（每条 update 都带 `chat.type`），执行发生在本线程（踢人走
 * joinVerificationApi）。两边因此按变更镜像：主线程每次观测到新值就发一条
 * `chatKind`，Worker 重建与进程启动时整表重放（见 packages/antiRaid/index.ts）。
 *
 * 读出来的是三态。**「没观测到」不是「是普通群」**：镜像到达之前、或这个群从未
 * 有过一条被本进程处理的 update 时都读不到值，而绝大多数托管群是超级群。把未知
 * 折算成普通群，就会在超级群里用 `banChatMember` 打出一次真正的持久封禁——而
 * 「除 /block 与黑名单秒踢外一律只踢不封」是这套自动处置的硬约束。
 *
 * **冷启动有一段已知空窗**：进程刚起来时主线程那份表也是空的（它不落盘），而
 * 从日文件恢复出来的终态可能立刻就要踢人。那一轮在普通群里仍会按未知走
 * `unbanChatMember` 因而踢不动——与本次修复之前的行为相同，不会更糟。它自愈：
 * 那个群的下一条 update 就会补上镜像，而终态按 VERIFICATION_TERMINAL_RETRY_MS
 * 指数退避重试，最迟一个退避周期内接上。
 */

import { workerChatIsSupergroup } from "../../cache/workers/antiRaid/chatKind";

/** 应用一条主线程镜像过来的群类型变化。 */
export function applyChatKindChange(chatId: number, isSupergroup: boolean): void {
  workerChatIsSupergroup.set(chatId, isSupergroup);
}

/**
 * 这个群此刻是不是超级群。
 * @returns 确证是 true、确证不是 false、没观测到 undefined。
 */
export function chatIsSupergroup(chatId: number): boolean | undefined {
  return workerChatIsSupergroup.get(chatId);
}

/** 停管/`/init disable`/群 teardown：丢掉这个群的群类型镜像。 */
export function forgetWorkerChatKind(chatId: number): void {
  workerChatIsSupergroup.delete(chatId);
}

/** Worker stop/测试隔离时清空整表；重建后由主线程重放。 */
export function resetWorkerChatKind(): void {
  workerChatIsSupergroup.clear();
}
