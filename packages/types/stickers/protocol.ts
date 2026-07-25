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
