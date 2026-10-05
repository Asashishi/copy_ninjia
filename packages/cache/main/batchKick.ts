/** owner: main。 */

/**
 * 正在处理 `/batch_kick` 批次的群（commands/batchKick.ts），同一群同一时刻只允许一批。
 *
 * 命令在提交延迟命令执行器之前登记，提交被拒时当场摘除；批次任务结算时在 finally 里摘除。
 * 排队期间被停机取消、从未开始的任务不会摘除——停机后执行器不再接纳，进程退出即清空。
 * 容量：每个受管群至多一项，因此不超过 STATE_MANAGED_CHAT_LIMIT；不做淘汰。主线程不随
 * Worker 重建，进程重启从空集开始，不恢复未完成的批次。
 */
export const batchKickChats: Set<number> = new Set();
