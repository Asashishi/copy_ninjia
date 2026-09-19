/**
 * 随机图片：`/h_image` 的目录准备与抽取。
 *
 * 只做「从目录抽一张并读出字节」，不持有缓存，也不发送；目录路径由调用方传入
 * （部署默认值见 infra/storage/stateStore.ts 的 getRandomImageDirectory）。每次抽取都
 * 重新枚举目录，增删图片不用重启；低频路径，不缓存目录列表。
 */

import { mkdir, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { extname, join } from "node:path";
import { STATE_FILE_PATH } from "../consts/paths";
import { RANDOM_IMAGE_EXTENSIONS, RANDOM_IMAGE_MAX_BYTES } from "../consts/randomImage";
import { isErrno } from "../libs/errno";
import { InputValidationError } from "../libs/inputValidation";
import { pickRandom } from "../libs/random";
import { logger } from "./logger";
import type { RandomImageMimeType, RandomImagePick } from "../types/randomImage";

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

/** 列目录之后、读文件之前被删除、改名或换成目录的候选。 */
function vanished(error: unknown): boolean {
  return isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR") || isErrno(error, "EISDIR");
}

/**
 * 从目录非递归地均匀抽一张图片并读出字节。候选是扩展名命中 RANDOM_IMAGE_EXTENSIONS
 * 的非隐藏普通文件（符号链接与子目录不算）；抽中的文件超过 RANDOM_IMAGE_MAX_BYTES
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
  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    if (RANDOM_IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) candidates.push(entry.name);
  }
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
