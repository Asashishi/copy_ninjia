import { readFileSync } from "node:fs";
import { defaultStickerConfigCache } from "../cache/perThread/config";
import { MAX_CONFIGURED_STICKER_PACKS, STICKER_PACK_NAME_PATTERN } from "../consts/aiChat/stickers";
import { STICKERS_CONFIG_PATH } from "../consts/paths";
import { hasExactKeys, isPlainRecord } from "../libs/runtimeConfig";
import type { StickerConfig } from "../types/config";

/** 严格解码 stickers.json，并拒绝超量、非法或重复的贴纸包 short name。 */
export function parseStickerConfig(value: unknown): StickerConfig {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["packs"]) || !Array.isArray(value.packs)) {
    throw new Error("Invalid stickers config: expected exactly { packs: string[] }");
  }
  if (value.packs.length > MAX_CONFIGURED_STICKER_PACKS) {
    throw new Error(`Invalid stickers config: at most ${MAX_CONFIGURED_STICKER_PACKS} packs are allowed`);
  }

  const packs: string[] = [];
  const seen: Set<string> = new Set();
  for (const pack of value.packs) {
    if (typeof pack !== "string" || !STICKER_PACK_NAME_PATTERN.test(pack)) {
      throw new Error(`Invalid stickers config pack name: ${JSON.stringify(pack)}`);
    }
    if (seen.has(pack)) throw new Error(`Duplicate stickers config pack name: ${pack}`);
    seen.add(pack);
    packs.push(pack);
  }
  return Object.freeze({ packs: Object.freeze(packs) });
}

/** 从指定文件加载并校验；模块 import 本身不访问文件系统。 */
export function loadStickerConfig(path: string = STICKERS_CONFIG_PATH): StickerConfig {
  return parseStickerConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

/** 默认部署配置按进程/Worker 惰性加载一次。主进程会在取得实例锁后预先调用。 */
export function getStickerConfig(): StickerConfig {
  defaultStickerConfigCache.current ??= loadStickerConfig();
  return defaultStickerConfigCache.current;
}
