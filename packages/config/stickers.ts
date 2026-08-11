import { defaultStickerConfigCache } from "../cache/perThread/config";
import { MAX_CONFIGURED_STICKER_PACKS, STICKER_PACK_NAME_PATTERN } from "../consts/aiChat/stickers";
import { STICKERS_CONFIG_PATH } from "../consts/paths";
import { hasExactKeys, isPlainRecord } from "../libs/record";
import { invalidInput, readJsonInput } from "../libs/inputValidation";
import type { StickerConfig } from "../types/config";

/** 严格解码 stickers.json，并拒绝超量、非法或重复的贴纸包 short name。 */
export function parseStickerConfig(
  value: unknown,
  sourcePath: string = STICKERS_CONFIG_PATH
): StickerConfig {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["packs"]) || !Array.isArray(value.packs)) {
    return invalidInput(sourcePath, "$", "exactly { packs: string[] }");
  }
  if (value.packs.length > MAX_CONFIGURED_STICKER_PACKS) {
    return invalidInput(sourcePath, "$.packs", `an array with at most ${MAX_CONFIGURED_STICKER_PACKS} entries`);
  }

  const packs: string[] = [];
  const seen: Set<string> = new Set();
  for (let index: number = 0; index < value.packs.length; index++) {
    const pack: unknown = value.packs[index];
    if (typeof pack !== "string" || !STICKER_PACK_NAME_PATTERN.test(pack)) {
      return invalidInput(sourcePath, `$.packs[${index}]`, "a valid Telegram sticker pack short name");
    }
    if (seen.has(pack)) return invalidInput(sourcePath, `$.packs[${index}]`, "unique");
    seen.add(pack);
    packs.push(pack);
  }
  return { packs };
}

/** 从指定文件加载并校验；模块 import 本身不访问文件系统。 */
export function loadStickerConfig(path: string = STICKERS_CONFIG_PATH): StickerConfig {
  return parseStickerConfig(readJsonInput(path), path);
}

/**
 * 默认部署配置按进程/Worker 惰性缓存。主进程启动总闸会校验已存在的文件；
 * 真正缺省时仍由功能 readiness 决定该功能能否开启。
 */
export function getStickerConfig(): StickerConfig {
  defaultStickerConfigCache.current ??= loadStickerConfig();
  return defaultStickerConfigCache.current;
}
