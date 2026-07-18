import { readFileSync } from "node:fs";
import { STICKERS_CONFIG_PATH } from "../../consts/paths";
import { parseStickerConfig } from "../../libs/runtimeConfig";
import type { StickerConfig } from "../../types/stickers";

export { parseStickerConfig } from "../../libs/runtimeConfig";
export type { StickerConfig } from "../../types/stickers";

/**
 * config/stickers.json 的解析结果，独立成模块只为打破循环依赖：
 * ai/tools/stickers.ts（挑选并发送贴纸，import ai/stickers/catalog.ts 查目录）与
 * ai/stickers/catalog.ts（贴纸目录生成）都要读 packs 白名单——若把配置挂在
 * 其中一个模块下，另一个模块要读 packs 就得反过来 import 它，与已有的
 * stickers.ts -> stickerCatalog.ts 方向凑成 import 环。
 */
export const stickerConfig: StickerConfig = parseStickerConfig(JSON.parse(readFileSync(STICKERS_CONFIG_PATH, "utf8")) as unknown);
