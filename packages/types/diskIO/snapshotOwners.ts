/**
 * 落盘函数边界；生产使用真实实现，owner 单测可注入确定性的替身。
 *
 * 只覆盖写与删：启动恢复走的是跨域 inspect/adopt/maintenance 三阶段编排
 * （见 workers/diskIO/startup.ts），读盘那一步不经过本边界。
 */
export interface AiMemorySnapshotFileDependencies {
  write(chatId: number, snapshot: string): void;
  delete(chatId: number): void;
}

/** 贴纸目录快照对应的落盘函数边界；理由同上，只覆盖写。 */
export interface StickerCatalogFileDependencies {
  write(pack: string, snapshot: string): void;
}
