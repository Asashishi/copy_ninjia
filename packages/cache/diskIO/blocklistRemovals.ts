import type { PendingBlockedRemoval } from "../../types/blocklist";

/** 黑名单成员移除 outbox（packages/workers/diskIO/blocklistRemovalOutbox.ts）的 Worker 状态。 */

/**
 * 当前 outbox 快照。启动恢复或覆盖消息填充；成功原子写后仍保留为 Worker
 * 事实源，flush 失败时按同一快照重试，Worker 重建后从文件重新恢复。
 */
export const blocklistRemovalOutbox: Map<number, PendingBlockedRemoval> = new Map();

/** 最近一次 outbox 原子重写是否失败；flush 据此重试而不能误报成功。 */
export const blocklistRemovalOutboxDirty: { current: boolean } = { current: false };

/** Worker 启动恢复前清空旧 isolate 状态。 */
export function resetBlocklistRemovalOutboxCache(): void {
  blocklistRemovalOutbox.clear();
  blocklistRemovalOutboxDirty.current = false;
}
