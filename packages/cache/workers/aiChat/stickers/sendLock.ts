/** 同群发贴纸锁的权威内存状态：回复轮取得锁时填入 chatId -> 当前回复轮令牌。
 * 仅 aiChat/ai/stickers/sendLock.ts 直接读写；锁严格随回复轮 finally 释放，Worker
 * 重启时整张表自然清空，因此不设 TTL、也不落盘。
 * 容量：同时持有发贴纸锁的群数，上界为受管群数（STATE_MANAGED_CHAT_LIMIT）；
 * 不设淘汰——丢掉一把锁会让同群两轮同时发贴纸。 */
export const stickerSendLocks: Map<number, object> = new Map();
