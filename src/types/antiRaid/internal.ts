import type { LinkedQueue } from "../../libs/linkedQueue";

/** 反刷群 Worker 的入群滑动计数窗口。 */
export interface JoinWindow {
  timestamps: LinkedQueue<number>;
  resetTimeout: ReturnType<typeof setTimeout>;
}

/** 某群是否有关联频道的 TTL 缓存条目。 */
export interface LinkedChannelCache {
  hasLinked: boolean;
  fetchedAt: number;
}

/** 某群管理员表的 TTL 缓存条目。 */
export interface ChatAdminCache {
  adminIds: Set<number>;
  fetchedAt: number;
}
