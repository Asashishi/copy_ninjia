import type { AppendOnlyFileState, BlockedUserRecord } from "../../types/diskIO/storage";

/** 黑名单文件落盘（packages/workers/diskIO/blocklistFile.ts）的 Worker 侧内存状态。 */

/**
 * 黑名单文件的追加游标。启动恢复（hydrateBlocklist）时建立；某次追加失败后
 * 置 null，下次写入前重新打开并校验文件，避免在损坏的结尾上继续追加。
 */
export const blocklistFileState: { current: AppendOnlyFileState | null } = { current: null };

/**
 * 文件里已经存在的用户 id。用于跳过重复追加：主线程侧同样会先查 Map 再投递，
 * 这里是第二道闸——两条路径都失效时，重复 key 会让文件里同一个 id 出现两次
 * （JSON.parse 取最后一条，不致命，但没必要）。
 */
export const blocklistKnownIds: Set<number> = new Set();

/**
 * 尚未成功落盘的条目文本（已按 serializeDayFileEntry 序列化）。正常路径下
 * 收到消息就立即追加、随即清空；只有写盘失败时才滞留，等下一次拉黑或停机
 * 前的统一 flush 重试。
 */
export const blocklistPendingEntries: string[] = [];

/**
 * 尚未成功落盘的整份重写（/unblock 的载体）。追加缓冲兜不住它：删除只能靠
 * 重写表达，重写失败时 blocklistPendingEntries 是空的，不单独记一笔的话
 * flushBlocklistAppends 会直接报成功——`/unblock` 于是告诉管理员「划掉了」，
 * 而文件里那条还在，重启就复活。
 *
 * 生命周期：rewriteBlocklist 失败时存下这份快照，成功时清空；下一次 flush
 * 先补这一笔。重写没落地期间新到的拉黑要并进这份快照（见 blocklistFile.ts 的
 * handleBlockUserMessage），否则重试重写会把它们挤掉。
 */
export const blocklistPendingRewrite: { current: Map<number, BlockedUserRecord> | null } = { current: null };

/** Worker 恢复/重启时清空游标、已知 id 与未落盘缓冲。 */
export function resetBlocklistCache(): void {
  blocklistFileState.current = null;
  blocklistKnownIds.clear();
  blocklistPendingEntries.length = 0;
  blocklistPendingRewrite.current = null;
}
