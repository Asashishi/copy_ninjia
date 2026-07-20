/** 文件系统函数边界；生产使用真实实现，owner 单测可注入确定性的替身。 */
export interface AiMemorySnapshotFileDependencies {
  recover(): Map<number, string>;
  write(chatId: number, snapshot: string): void;
  delete(chatId: number): void;
}

/** 贴纸目录快照对应的文件系统函数边界。 */
export interface StickerCatalogFileDependencies {
  recover(activePacks: readonly string[]): Map<string, string>;
  write(pack: string, snapshot: string): void;
}
