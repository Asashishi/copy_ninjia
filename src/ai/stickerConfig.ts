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
  /** AI 每次回复后，额外触发一次贴纸发送的概率（0~1）。 */
  replyStickerProbability: number;
  /** 贴纸包白名单，取值为 t.me/addstickers/<name> 里的 <name>（贴纸集合的 short name）。 */
  packs: string[];
  /** 情绪 -> 关键词：模型按目录描述选贴纸失败/弃权时的兜底匹配表，见
   *  ai/stickers.ts 的 pickStickerByKeywords。 */
  emotionKeywords: Record<string, string[]>;
}

export const stickerConfig: StickerConfig = JSON.parse(readFileSync(STICKERS_CONFIG_PATH, "utf8"));
