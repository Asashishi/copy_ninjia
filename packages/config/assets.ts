/**
 * config/dynamic/assets.json 的严格解析：顶层只有 `onlyPath`、`pathOrUrl` 与 `onlyUrl` 分组。
 *
 * - `onlyPath`：`random_h_image_dir`，随机图库的本机目录。
 * - `pathOrUrl`：`bot_default_avatar`，机器人默认头像的本机文件或本进程下载的 http(s) 直链。
 * - `onlyUrl`：inline 结果缩略图直链，由 Telegram 拉取，只收绝对 https URL。
 *
 * 本机路径只收绝对路径或 `./`、`../` 开头的相对路径，相对路径按运行时数据根解析。
 * 文件、各分组与组内字段都可选，缺省按「从没设过」取 consts/ui/assets.ts 的内置常量；分组或字段
 * 存在但非法、出现未知分组或组外字段、顶层或分组不是对象时整份拒绝，报错只含文件路径、字段路径与
 * 期望形态。parseAssetConfig 只做形态与路径的词法判定，不做 I/O；loadAssetConfig 在读盘后再核对默认
 * 头像的本机文件（见 verifyDefaultAvatarFile）。启动总闸（config/readiness.ts）在文件存在时
 * 解析并接管；config/dynamic/ 热重载经 config/reload.ts 整体替换。快照只在主线程（cache/main/assets.ts）。
 */

import type { BunFile } from "bun";
import { isAbsolute, resolve } from "node:path";
import { assetConfigCache } from "../cache/main/assets";
import { ASSETS_CONFIG_PATH, RUNTIME_DATA_ROOT } from "../consts/paths";
import { DEFAULT_AVATAR_EXPECTED_FORM, DEFAULT_AVATAR_MAX_READ_BYTES } from "../consts/telegram";
import {
  ASSET_CONFIG_GROUPS,
  ASSET_ONLY_PATH_GROUP,
  ASSET_ONLY_PATH_KEYS,
  ASSET_ONLY_URL_GROUP,
  ASSET_ONLY_URL_KEYS,
  ASSET_PATH_OR_URL_GROUP,
  ASSET_PATH_OR_URL_KEYS,
  BOT_DEFAULT_AVATAR_FIELD,
  DEFAULT_ASSET_CONFIG,
  RANDOM_H_IMAGE_DIR_FIELD,
} from "../consts/ui/assets";
import { defaultAvatarPhotoType } from "../infra/telegram/avatar/photoType";
import { invalidInput, readJsonInput } from "../libs/inputValidation";
import { isPlainRecord } from "../libs/record";
import type { AssetConfig, DefaultAvatarSource } from "../types/config";

/** 通过形态校验的一个顶层分组：分组名、组内字段与报错文件路径。 */
interface AssetGroup {
  readonly name: string;
  readonly entries: Readonly<Record<string, unknown>>;
  readonly sourcePath: string;
}

/** readAssetGroup 的入参：分组名、组内允许的字段与报错文件路径。 */
interface AssetGroupOptions {
  readonly name: string;
  readonly keys: ReadonlySet<string>;
  readonly sourcePath: string;
}

/** 顶层分组：缺省按空组处理（组内字段全取缺省）；不是对象或含组外字段时拒绝整份文件。 */
function readAssetGroup(
  raw: Readonly<Record<string, unknown>>,
  { name, keys, sourcePath }: AssetGroupOptions
): AssetGroup {
  const value: unknown = raw[name];
  if (value === undefined) return { name, entries: {}, sourcePath };
  if (!isPlainRecord(value)) return invalidInput(sourcePath, `$.${name}`, "an object");
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      return invalidInput(sourcePath, `$.${name}.<key>`, "absent (not part of the current assets schema)");
    }
  }
  return { name, entries: value, sourcePath };
}

/** 组内字符串字段：缺省返回 undefined；去掉首尾空白后收下，不是字符串或去掉后为空时拒绝。 */
function trimmedField(group: AssetGroup, key: string): string | undefined {
  const value: unknown = group.entries[key];
  if (value === undefined) return undefined;
  const text: string = typeof value === "string" ? value.trim() : "";
  if (text.length === 0) return invalidInput(group.sourcePath, `$.${group.name}.${key}`, "a non-empty string");
  return text;
}

/** 绝对 https URL（allowHttp 时也接受 http）归一化后的 href；形态不符时返回 null。 */
function assetUrlHref(text: string, allowHttp: boolean): string | null {
  const parsed: URL | null = URL.parse(text);
  if (parsed === null) return null;
  if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) return null;
  return parsed.href;
}

/**
 * 本机路径的词法判定：只收绝对路径或以 `./`、`../` 开头的显式相对路径，不含 NUL；裸名与
 * `~` 开头的写法都不算。命中时返回按运行时数据根解析后的绝对路径，否则返回 null。
 */
function localPath(text: string): string | null {
  if (text.includes("\0") || (!isAbsolute(text) && !text.startsWith("./") && !text.startsWith("../"))) return null;
  return resolve(RUNTIME_DATA_ROOT, text);
}

/** `onlyUrl` 组的缩略图直链：由 Telegram 拉取，必须是绝对 https URL，收下 URL 归一化后的 href。 */
function thumbnailUrl(group: AssetGroup, key: string, fallback: string): string {
  const text: string | undefined = trimmedField(group, key);
  if (text === undefined) return fallback;
  const href: string | null = assetUrlHref(text, false);
  if (href === null) return invalidInput(group.sourcePath, `$.${group.name}.${key}`, "an absolute https URL");
  return href;
}

/**
 * `pathOrUrl` 组的机器人默认头像来源：本机路径形态（见 localPath）收为本机文件，其余必须是
 * 绝对 http 或 https URL，收下 URL 归一化后的 href。
 */
function defaultAvatarSource(group: AssetGroup): DefaultAvatarSource {
  const text: string | undefined = trimmedField(group, "bot_default_avatar");
  if (text === undefined) return DEFAULT_ASSET_CONFIG.botDefaultAvatar;
  const path: string | null = localPath(text);
  if (path !== null) return { kind: "path", path };
  const url: string | null = assetUrlHref(text, true);
  if (url === null) {
    return invalidInput(
      group.sourcePath,
      BOT_DEFAULT_AVATAR_FIELD,
      "an absolute http or https URL, an absolute path, or a relative path starting with ./ or ../, without NUL"
    );
  }
  return { kind: "url", url };
}

/** `onlyPath` 组的随机图片目录：只收本机路径形态（见 localPath），按运行时数据根解析为绝对路径。 */
function assetDirectory(group: AssetGroup): string {
  const text: string | undefined = trimmedField(group, "random_h_image_dir");
  if (text === undefined) return DEFAULT_ASSET_CONFIG.randomHImageDirectory;
  const directory: string | null = localPath(text);
  if (directory === null) {
    return invalidInput(
      group.sourcePath,
      RANDOM_H_IMAGE_DIR_FIELD,
      "an absolute path or a relative path starting with ./ or ../, without NUL"
    );
  }
  return directory;
}

/**
 * 核对默认头像的本机文件：存在且是普通文件（跟随符号链接），且字节签名、大小与 MP4 视频轨尺寸符合
 * DEFAULT_AVATAR_EXPECTED_FORM（判定见 defaultAvatarPhotoType）。最多读 DEFAULT_AVATAR_MAX_READ_BYTES
 * 加一个字节，超出的文件必然超过所属形态的上限；读不到一律按不存在处理。
 */
async function verifyDefaultAvatarFile(path: string, sourcePath: string): Promise<void> {
  let bytes: Uint8Array | null;
  try {
    const file: BunFile = Bun.file(path);
    bytes = (await file.stat()).isFile() ? await file.slice(0, DEFAULT_AVATAR_MAX_READ_BYTES + 1).bytes() : null;
  } catch {
    bytes = null;
  }
  if (bytes === null) return invalidInput(sourcePath, BOT_DEFAULT_AVATAR_FIELD, "an existing readable regular file");
  if (defaultAvatarPhotoType(bytes) === null) {
    return invalidInput(sourcePath, BOT_DEFAULT_AVATAR_FIELD, DEFAULT_AVATAR_EXPECTED_FORM);
  }
}

/** 严格解码 assets.json 并按内置常量补齐缺省字段。 */
export function parseAssetConfig(value: unknown, sourcePath: string = ASSETS_CONFIG_PATH): AssetConfig {
  if (!isPlainRecord(value)) return invalidInput(sourcePath, "$", "an object");
  for (const key of Object.keys(value)) {
    if (!ASSET_CONFIG_GROUPS.has(key)) {
      return invalidInput(sourcePath, "$.<key>", "absent (not part of the current assets schema)");
    }
  }
  const onlyPath: AssetGroup = readAssetGroup(value, {
    name: ASSET_ONLY_PATH_GROUP,
    keys: ASSET_ONLY_PATH_KEYS,
    sourcePath,
  });
  const pathOrUrl: AssetGroup = readAssetGroup(value, {
    name: ASSET_PATH_OR_URL_GROUP,
    keys: ASSET_PATH_OR_URL_KEYS,
    sourcePath,
  });
  const onlyUrl: AssetGroup = readAssetGroup(value, {
    name: ASSET_ONLY_URL_GROUP,
    keys: ASSET_ONLY_URL_KEYS,
    sourcePath,
  });
  return {
    randomHImageDirectory: assetDirectory(onlyPath),
    fortuneThumbnailUrl: thumbnailUrl(onlyUrl, "fortune_thumbnail_url", DEFAULT_ASSET_CONFIG.fortuneThumbnailUrl),
    probabilityThumbnailUrl: thumbnailUrl(
      onlyUrl,
      "probability_thumbnail_url",
      DEFAULT_ASSET_CONFIG.probabilityThumbnailUrl
    ),
    gagThumbnailUrl: thumbnailUrl(onlyUrl, "gag_thumbnail_url", DEFAULT_ASSET_CONFIG.gagThumbnailUrl),
    botDefaultAvatar: defaultAvatarSource(pathOrUrl),
  };
}

/** 从指定文件加载并严格解析，默认头像是本机文件时再核对该文件；模块 import 本身不访问文件系统。 */
export async function loadAssetConfig(path: string = ASSETS_CONFIG_PATH): Promise<AssetConfig> {
  const config: AssetConfig = parseAssetConfig(await readJsonInput(path), path);
  if (config.botDefaultAvatar.kind === "path") await verifyDefaultAvatarFile(config.botDefaultAvatar.path, path);
  return config;
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
