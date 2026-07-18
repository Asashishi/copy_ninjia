import type { Sticker } from "@grammyjs/types";

/** stickers.json 解码后的只读结构。 */
export interface StickerConfig {
  readonly packs: readonly string[];
}

/** 单枚白名单贴纸的常驻目录条目。 */
export interface StickerCatalogEntry {
  emoji: string;
  description: string;
}

/** memory/stickers/<pack>.json 的版本化落盘结构。 */
export interface StickerCatalogSnapshot {
  version: 1;
  entries: Record<string, StickerCatalogEntry>;
  summary: string | null;
  savedAt: number;
}

/** 主线程 -> AI Worker：恢复持久化的贴纸目录。 */
export interface AiHydrateStickerCatalogMessage {
  type: "hydrateStickerCatalog";
  catalogs: Map<string, string>;
}

/** AI Worker -> 主线程：上报一个 dirty 包的序列化目录。 */
export interface AiStickerCatalogEvent {
  type: "stickerCatalog";
  pack: string;
  snapshot: string;
}

/** 同群跨回复轮的发贴纸互斥锁句柄。 */
export interface StickerSendLockControl {
  tryAcquire(): boolean;
  release(): void;
}

/** 工具菜单中的一枚候选贴纸。 */
export interface StickerCandidate {
  sticker: Sticker;
  emoji: string;
  description: string;
}

/** 工具菜单中的一个候选贴纸包。 */
export interface StickerPackCandidate {
  pack: string;
  title: string;
  summary: string;
  stickers: StickerCandidate[];
}

/** 一轮回复内两层贴纸工具共享的查看记录与发送限额状态。 */
export interface StickerRoundState {
  viewedPackIntents: Map<number, string>;
  sentStickerUids: Set<string>;
}
