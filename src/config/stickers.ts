import { readFileSync } from "node:fs";
import { STICKERS_CONFIG_PATH } from "../consts/paths";
import { hasExactKeys, isPlainRecord } from "../libs/runtimeConfig";

export interface StickerConfig {
  readonly packs: readonly string[];
}

const STICKER_PACK_NAME_PATTERN: RegExp = /^[A-Za-z0-9_]{1,64}$/;
let defaultConfig: StickerConfig | null = null;

/** 严格解码 stickers.json，并拒绝非法或重复的贴纸包 short name。 */
export function parseStickerConfig(value: unknown): StickerConfig {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["packs"]) || !Array.isArray(value.packs)) {
    throw new Error("Invalid stickers config: expected exactly { packs: string[] }");
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
  defaultConfig ??= loadStickerConfig();
  return defaultConfig;
}
