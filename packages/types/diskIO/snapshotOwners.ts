/** 文件系统函数边界；生产使用真实实现，owner 单测可注入确定性的替身。 */
export interface AiMemorySnapshotFileDependencies {
  recover(): Map<number, string>;
  write(chatId: number, snapshot: string): void;
  delete(chatId: number): void;
}

/** 贴纸目录快照对应的文件系统函数边界。 */
export interface StickerCatalogFileDependencies {
  /** activePacks 为 null 表示白名单读不出来：只读不删、也不因 schema 不匹配拒绝启动。 */
  recover(activePacks: readonly string[] | null): Map<string, string>;
  write(pack: string, snapshot: string): void;
}
