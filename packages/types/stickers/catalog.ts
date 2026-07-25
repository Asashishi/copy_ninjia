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
