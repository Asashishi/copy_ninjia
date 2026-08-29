/** 同群发贴纸锁的权威内存状态：回复轮取得锁时填入 chatId -> 当前回复轮令牌。
 * 仅 aiChat/ai/stickers/sendLock.ts 直接读写；锁严格随回复轮 finally 释放，Worker
 * 重启时整张表自然清空，因此不设 TTL、也不落盘。 */
export const stickerSendLocks: Map<number, object> = new Map();
