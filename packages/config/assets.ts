/**
 * config/dynamic/assets.json 的严格解析：随机图片目录与四条外部素材直链。
 *
 * 文件与五个字段都可选，缺省按「从没设过」取 consts/ui/assets.ts 的内置常量；字段存在但
 * 非法、出现未知字段或顶层不是对象时整份拒绝，报错只含文件路径、字段路径与期望形态。
 * 启动总闸（config/readiness.ts）在文件存在时解析并接管；config/dynamic/ 热重载经 config/reload.ts
 * 整体替换。快照只在主线程（cache/main/assets.ts）。
 */

import { isAbsolute, resolve } from "node:path";
import { assetConfigCache } from "../cache/main/assets";
import { ASSETS_CONFIG_PATH, RUNTIME_DATA_ROOT } from "../consts/paths";
import { ASSET_CONFIG_KEYS, DEFAULT_ASSET_CONFIG } from "../consts/ui/assets";
import { invalidInput, readJsonInput } from "../libs/inputValidation";
import { isPlainRecord } from "../libs/record";
import type { AssetConfig } from "../types/config";

/** assetUrl 的入参：字段名、缺省值与报错文件路径。 */
interface AssetUrlOptions {
  readonly key: string;
  readonly fallback: string;
  readonly sourcePath: string;
  /** true 时也接受 http；只用于机器人默认头像。 */
  readonly allowHttp?: boolean;
}

/** 字符串去掉首尾空白后收下；不是字符串或去掉后为空时拒绝。 */
function trimmedString(value: unknown, sourcePath: string, key: string): string {
  const text: string = typeof value === "string" ? value.trim() : "";
  if (text.length === 0) return invalidInput(sourcePath, `$.${key}`, "a non-empty string");
  return text;
}

/** 外部素材直链：必须是绝对 https URL（allowHttp 时也接受 http），收下 URL 归一化后的 href。 */
function assetUrl(
  raw: Readonly<Record<string, unknown>>,
  { key, fallback, sourcePath, allowHttp = false }: AssetUrlOptions
): string {
  const value: unknown = raw[key];
  if (value === undefined) return fallback;
  const text: string = trimmedString(value, sourcePath, key);
  const expected: string = allowHttp ? "an absolute http or https URL" : "an absolute https URL";
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return invalidInput(sourcePath, `$.${key}`, expected);
  }
  if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
    return invalidInput(sourcePath, `$.${key}`, expected);
  }
  return parsed.href;
}

/**
 * 随机图片目录：只收绝对路径或以 `./`、`../` 开头的显式相对路径，不含 NUL；裸目录名与
 * `~` 开头的写法一律拒绝。相对路径按运行时数据根解析为绝对路径。
 */
function assetDirectory(raw: Readonly<Record<string, unknown>>, sourcePath: string): string {
  const value: unknown = raw.random_h_image_dir;
  if (value === undefined) return DEFAULT_ASSET_CONFIG.randomHImageDirectory;
  const text: string = trimmedString(value, sourcePath, "random_h_image_dir");
  if (text.includes("\0") || (!isAbsolute(text) && !text.startsWith("./") && !text.startsWith("../"))) {
    return invalidInput(
      sourcePath,
      "$.random_h_image_dir",
      "an absolute path or a relative path starting with ./ or ../, without NUL"
    );
  }
  return resolve(RUNTIME_DATA_ROOT, text);
}

/** 严格解码 assets.json 并按内置常量补齐缺省字段。 */
export function parseAssetConfig(value: unknown, sourcePath: string = ASSETS_CONFIG_PATH): AssetConfig {
  if (!isPlainRecord(value)) return invalidInput(sourcePath, "$", "an object");
  for (const key of Object.keys(value)) {
    if (!ASSET_CONFIG_KEYS.has(key)) {
      return invalidInput(sourcePath, `$.${key}`, "absent (not part of the current assets schema)");
    }
  }
  return {
    randomHImageDirectory: assetDirectory(value, sourcePath),
    fortuneThumbnailUrl: assetUrl(value, {
      key: "fortune_thumbnail_url",
      fallback: DEFAULT_ASSET_CONFIG.fortuneThumbnailUrl,
      sourcePath,
    }),
    probabilityThumbnailUrl: assetUrl(value, {
      key: "probability_thumbnail_url",
      fallback: DEFAULT_ASSET_CONFIG.probabilityThumbnailUrl,
      sourcePath,
    }),
    gagThumbnailUrl: assetUrl(value, {
      key: "gag_thumbnail_url",
      fallback: DEFAULT_ASSET_CONFIG.gagThumbnailUrl,
      sourcePath,
    }),
    botDefaultAvatarUrl: assetUrl(value, {
      key: "bot_default_avatar_url",
      fallback: DEFAULT_ASSET_CONFIG.botDefaultAvatarUrl,
      sourcePath,
      allowHttp: true,
    }),
  };
}

/** 从指定文件加载并校验；模块 import 本身不访问文件系统。 */
export async function loadAssetConfig(path: string = ASSETS_CONFIG_PATH): Promise<AssetConfig> {
  return parseAssetConfig(await readJsonInput(path), path);
}

/** 接管已经严格校验的素材快照：启动总闸或 config/dynamic/ 热重载（文件删除时传入内置缺省）。 */
export function adoptAssetConfig(config: Readonly<AssetConfig>): void {
  assetConfigCache.current = config;
}

/** 启动总闸在 assets.json 存在时调用：解析并接管；文件缺省时不调用，holder 保持内置缺省。 */
export async function ensureAssetConfig(): Promise<void> {
  adoptAssetConfig(await loadAssetConfig());
}

/** 主线程当前生效的素材配置。 */
export function getAssetConfig(): Readonly<AssetConfig> {
  return assetConfigCache.current;
}
