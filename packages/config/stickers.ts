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
  return { packs };
}

/** 从指定文件加载并校验；模块 import 本身不访问文件系统。 */
export function loadStickerConfig(path: string = STICKERS_CONFIG_PATH): StickerConfig {
  return parseStickerConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

/**
 * 默认部署配置按进程/Worker 惰性加载一次。**主进程不得在启动阶段统一预热**
 * （见 docs/04-invariants.md 与 app/lifecycle.ts 的说明）：这些都是按群 opt-in
 * 的可选功能配置，一份写坏的文件在启动阶段抛出，会连带 copy、抽奖、入群验证、
 * 黑名单一起离线，systemd 还会照着重启循环。校验归各功能自己的 enable 分支
 * （config/readiness.ts 与 commands/configGate.ts），坏了只拒绝那一个功能。
 */
export function getStickerConfig(): StickerConfig {
  defaultStickerConfigCache.current ??= loadStickerConfig();
  return defaultStickerConfigCache.current;
}
