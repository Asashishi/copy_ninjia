/**
 * 贴纸目录快照的落盘函数边界；生产使用真实实现，owner 单测可注入确定性的替身。
 *
 * 只覆盖写；启动恢复的读盘不经过本边界（见 workers/diskIO/startup.ts）。
 */
export interface StickerCatalogFileDependencies {
  write(pack: string, snapshot: string): void;
}
