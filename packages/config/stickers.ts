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
export async function loadStickerConfig(
  path: string = STICKERS_CONFIG_PATH
): Promise<StickerConfig> {
  return parseStickerConfig(await readJsonInput(path), path);
}

/** 接管启动预检或 Worker 初始化消息已经严格校验的贴纸配置快照。 */
export function adoptStickerConfig(config: StickerConfig): void {
  defaultStickerConfigCache.current = config;
}

/** 启动预检填充默认路径快照；重复调用只读 holder。 */
export async function ensureStickerConfig(): Promise<void> {
  if (defaultStickerConfigCache.current !== null) return;
  adoptStickerConfig(await loadStickerConfig());
}

/** 默认贴纸配置只读当前线程已校验的快照，不在运行期回退读盘。 */
export function getStickerConfig(): StickerConfig {
  const config: StickerConfig | null = defaultStickerConfigCache.current;
  if (config === null) {
    throw new Error(`Sticker configuration was not initialized from ${STICKERS_CONFIG_PATH}.`);
  }
  return config;
}
