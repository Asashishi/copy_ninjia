import { readFileSync } from "node:fs";
import { STICKERS_CONFIG_PATH } from "../consts/paths";

/**
 * config/stickers.json 的解析结果，独立成模块只为打破循环依赖：
 * ai/stickers.ts（挑选并发送贴纸，import ai/stickerCatalog.ts 查目录）与
 * ai/stickerCatalog.ts（贴纸目录生成）都要读 packs 白名单——若把配置挂在
 * 其中一个模块下，另一个模块要读 packs 就得反过来 import 它，与已有的
 * stickers.ts -> stickerCatalog.ts 方向凑成 import 环。
 */
export interface StickerConfig {
  /** 贴纸包白名单，取值为 t.me/addstickers/<name> 里的 <name>（贴纸集合的 short name）。 */
  packs: string[];
}

export const stickerConfig: StickerConfig = JSON.parse(readFileSync(STICKERS_CONFIG_PATH, "utf8"));
