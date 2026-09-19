/**
 * 随机图片：`/h_image` 的目录准备、抽取与收图写盘。
 *
 * 只做「从目录抽一张并读出字节」「数图库张数」和「把一张图写进目录」，不持有缓存，也不
 * 发送；目录路径由调用方传入（部署默认值见 infra/storage/stateStore.ts 的
 * getRandomImageDirectory）。
 * 每次抽取都重新枚举目录，增删图片不用重启；低频路径，不缓存目录列表。
 */

import { mkdir, readdir, rename } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { extname, join } from "node:path";
import { STATE_FILE_PATH } from "../consts/paths";
import {
  RANDOM_IMAGE_EXTENSIONS,
  RANDOM_IMAGE_FILE_UNIQUE_ID_PATTERN,
  RANDOM_IMAGE_MAX_BYTES,
  RANDOM_IMAGE_SAVE_EXTENSIONS,
  RANDOM_IMAGE_TEMP_PREFIX,
} from "../consts/randomImage";
import { isErrno } from "../libs/errno";
import { InputValidationError } from "../libs/inputValidation";
import { pickRandom } from "../libs/random";
import { logger } from "./logger";
import { sniffImageFormat } from "./image";
import type { RandomImageMimeType, RandomImagePick, StoreRandomImageResult } from "../types/randomImage";

/**
 * 启动时准备随机图片目录：已是目录（允许经符号链接指向别处）则不动；不存在则
 * 创建并记一行日志；存在但不是目录，或无法创建时抛出 InputValidationError，由启动
 * 总闸拒绝启动。只在 app/lifecycle.ts 的启动阶段、任何外部连接之前调用。
 * @param directory 已解析成绝对路径的目录。
 */
export async function ensureRandomImageDirectory(directory: string): Promise<void> {
  const invalid: InputValidationError = new InputValidationError(
    STATE_FILE_PATH,
    "state.global.assets.randomImageDir",
    `an existing or creatable directory (resolved to ${directory})`
  );
  try {
    if ((await Bun.file(directory).stat()).isDirectory()) return;
  } catch (error: unknown) {
    if (!isErrno(error, "ENOENT")) throw invalid;
    try {
      await mkdir(directory, { recursive: true, mode: 0o755 });
    } catch {
      throw invalid;
    }
    logger.log(`Created the random image directory ${directory}.`);
    return;
  }
  throw invalid;
}

/**
 * 目录项里算作图库图片的文件名：扩展名命中 RANDOM_IMAGE_EXTENSIONS 的非隐藏普通文件
 * （符号链接、子目录与收图写到一半的点号临时文件都不算）。抽图与计数共用这一口径。
 */
function randomImageNames(entries: readonly Dirent[]): string[] {
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    if (RANDOM_IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) names.push(entry.name);
  }
  return names;
}

/**
 * 图库里现有的图片张数，口径同 pickRandomImage 的候选；目录读取失败原样上抛。
 * @param directory 已解析成绝对路径的目录。
 */
export async function countRandomImages(directory: string): Promise<number> {
  return randomImageNames(await readdir(directory, { withFileTypes: true })).length;
}

/** 列目录之后、读文件之前被删除、改名或换成目录的候选。 */
function vanished(error: unknown): boolean {
  return isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR") || isErrno(error, "EISDIR");
}

/**
 * 从目录非递归地均匀抽一张图片并读出字节。候选口径见 randomImageNames；抽中的文件超过 RANDOM_IMAGE_MAX_BYTES
 * 时只报超限，不读入内存。抽中的文件在读取前已消失（部署方正在整理目录）时，从剩余
 * 候选里重新均匀抽取，候选抽完即报 empty；最多尝试候选数那么多次。
 * @param directory 已解析成绝对路径的目录。
 */
export async function pickRandomImage(directory: string): Promise<RandomImagePick> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return { status: "missingDirectory" };
    throw error;
  }
  const candidates: string[] = randomImageNames(entries);
  for (let fileName: string | undefined = pickRandom(candidates); fileName !== undefined; fileName = pickRandom(candidates)) {
    const path: string = join(directory, fileName);
    try {
      if ((await Bun.file(path).stat()).size > RANDOM_IMAGE_MAX_BYTES) return { status: "tooLarge", fileName };
      const mimeType: RandomImageMimeType = RANDOM_IMAGE_EXTENSIONS.get(extname(fileName).toLowerCase())!;
      return { status: "ok", bytes: await Bun.file(path).bytes(), mimeType, fileName };
    } catch (error: unknown) {
      if (!vanished(error)) throw error;
      candidates.splice(candidates.indexOf(fileName), 1);
    }
  }
  return { status: "empty" };
}

/** 路径此刻是不是目录（跟随符号链接）；不存在或读不到都按不是处理。 */
export async function isRandomImageDirectory(directory: string): Promise<boolean> {
  try {
    return (await Bun.file(directory).stat()).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 图库里是否已有这张图：收进来的文件以 file_unique_id 加保存扩展名命名，任一扩展名存在
 * 即算已有。file_unique_id 形态不符时抛出 RangeError，由调用方按失败计数。
 */
export async function hasStoredRandomImage(directory: string, fileUniqueId: string): Promise<boolean> {
  if (!RANDOM_IMAGE_FILE_UNIQUE_ID_PATTERN.test(fileUniqueId)) throw new RangeError("Unexpected Telegram file_unique_id shape.");
  for (const extension of RANDOM_IMAGE_SAVE_EXTENSIONS.values()) {
    if (await Bun.file(join(directory, `${fileUniqueId}${extension}`)).exists()) return true;
  }
  return false;
}

/**
 * 把一张图写进图库：按字节嗅探格式（只收 jpeg、png、webp），先写点号开头的临时文件，
 * 再在同一目录内改名为 `<file_unique_id><扩展名>`，抽图永远看不到写到一半的文件。改名
 * 覆盖同名文件：同一个 file_unique_id 就是同一份内容。写入或改名失败时删除临时文件并
 * 原样上抛。file_unique_id 形态不符时抛出 RangeError。
 * @param directory 已解析成绝对路径的图库目录。
 */
export async function storeRandomImage(
  directory: string,
  fileUniqueId: string,
  bytes: Uint8Array
): Promise<StoreRandomImageResult> {
  if (!RANDOM_IMAGE_FILE_UNIQUE_ID_PATTERN.test(fileUniqueId)) throw new RangeError("Unexpected Telegram file_unique_id shape.");
  const extension: string | undefined = RANDOM_IMAGE_SAVE_EXTENSIONS.get(sniffImageFormat(bytes));
  if (extension === undefined) return { status: "unsupportedFormat" };
  const fileName: string = `${fileUniqueId}${extension}`;
  const temporary: string = join(directory, `${RANDOM_IMAGE_TEMP_PREFIX}${crypto.randomUUID()}${extension}`);
  try {
    await Bun.write(temporary, bytes);
    await rename(temporary, join(directory, fileName));
  } catch (error: unknown) {
    await Bun.file(temporary).delete().catch((): undefined => undefined);
    throw error;
  }
  return { status: "stored", fileName };
}
