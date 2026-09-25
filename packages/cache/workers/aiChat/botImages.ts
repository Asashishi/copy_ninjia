/** owner: workers/aiChat。回复机器人图片时等待识图回填的登记表。 */

/**
 * 各群「回复了机器人图片、回复引用正在等识图回填」的消息：chatId → 这条回复的
 * message_id → 回填完成的 Promise（从不 reject）。
 *
 * 填充：workers/aiChat/botImages.ts 的 resolveRepliedBotImage 记录这条回复时登记。
 * 读取：workers/aiChat/replyRound.ts 在拼提示词前等待，本轮因此读得到识图结果。
 * 清理：Promise 结算时由同一模块按身份删除，内层表空时连外层键一并删除；按群
 * 失效与测试重置经 cache/workers/aiChat/index.ts 清空。
 * 容量：每项对应一次在途的媒体识别，受 cache/workers/aiChat/mediaTasks.ts 的有界
 * 执行器约束，识别结束即删除。
 * Worker 崩溃重建时随 isolate 清空；等待它的回复轮同在旧 isolate 内一并消失，无需重放。
 */
export const repliedBotImageBackfills: Map<number, Map<number, Promise<void>>> = new Map();

/** 按群失效：丢弃该群全部登记，在途识别仍按代际自行作废。 */
export function clearChatBotImageCache(chatId: number): void {
  repliedBotImageBackfills.delete(chatId);
}

/** 测试隔离用的全量清理。 */
export function resetAiChatBotImageCache(): void {
  repliedBotImageBackfills.clear();
}
