/**
 * 随机图片：`/h_image` 的目录准备、抽取与收图写盘。
 *
 * 启动时严格检查专用图库；运行时为 /h_image 与 cron 提供抽图、计数和按内容摘要收图。
 * 不持有缓存，也不发送；目录路径由调用方传入（部署值见 config/assets.ts 的 getAssetConfig）。
 * 每次抽取都重新枚举目录，增删图片不用重启；低频路径，不缓存目录列表。
 */

import { access, lstat, mkdir, readdir, rename } from "node:fs/promises";
import { constants } from "node:fs";
import type { Dirent } from "node:fs";
import { extname, join } from "node:path";
import { ASSETS_CONFIG_PATH } from "../consts/paths";
import {
  RANDOM_IMAGE_CONTENT_NAME_PATTERN,
  RANDOM_IMAGE_EXTENSIONS,
  RANDOM_IMAGE_MAX_BYTES,
  RANDOM_IMAGE_SAVE_EXTENSIONS,
  RANDOM_IMAGE_TEMP_PREFIX,
} from "../consts/randomImage";
import { isErrno } from "../libs/errno";
import { InputValidationError } from "../libs/inputValidation";
import { pickRandom } from "../libs/random";
import { logger } from "./logger";
import { sniffImageFormat } from "./image";
import type {
  RandomImageLibrary,
  RandomImageMimeType,
  RandomImagePick,
  StoreRandomImageResult,
} from "../types/randomImage";

/**
 * 准备 /h_image 专用图库并校验 SHA-256 文件名、扩展名与条目类型：启动时在外部连接之前
 * 调用（见 docs/cn/04-invariants.md），config/dynamic/ 热重载切换目录时在接管新快照之前调用。
 * 检查只读目录项，不重算内容摘要；不修复或清理非法条目。允许目录根链接，
 * 拒绝子目录、文件链接及临时文件；报错点名 config/dynamic/assets.json 的 random_h_image_dir。
 */
export async function ensureRandomImageDirectory(directory: string): Promise<void> {
  const field: string = "$.random_h_image_dir";
  const invalid: InputValidationError = new InputValidationError(
    ASSETS_CONFIG_PATH, field, `an accessible existing or creatable directory (resolved to ${directory})`
  );
  try {
    await lstat(directory);
  } catch (error: unknown) {
    if (!isErrno(error, "ENOENT")) throw invalid;
    try {
      await mkdir(directory, { recursive: true, mode: 0o755 });
    } catch {
      throw invalid;
    }
    logger.log(`Created the random image directory ${directory}.`);
  }
  let entries: Dirent[];
  try {
    if (!(await Bun.file(directory).stat()).isDirectory()) throw invalid;
    await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw invalid;
  }
  for (const entry of entries) {
    const extension: string = extname(entry.name);
    if (!entry.isFile() || !RANDOM_IMAGE_EXTENSIONS.has(extension.toLowerCase()) ||
      !RANDOM_IMAGE_CONTENT_NAME_PATTERN.test(entry.name.slice(0, -extension.length))) {
      throw new InputValidationError(join(directory, entry.name), field,
        "a regular image named <64 lowercase SHA-256 hex characters>.jpg/.jpeg/.png/.webp");
    }
  }
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
 * 列一次目录，给出图库张数；口径同 pickRandomImage 的候选，目录读取失败原样上抛。
 * `/h_image add` 整批只读这一次，用于汇总回执里的「收图前图库里有几张」。
 *
 * 只给张数，不给已收录集合：文件名是内容的 SHA-256（见 storeRandomImage），
 * 去重靠重算哈希，不依赖列目录或 file_unique_id。
 * @param directory 已解析成绝对路径的目录。
 */
export async function readRandomImageLibrary(directory: string): Promise<RandomImageLibrary> {
  return { size: randomImageNames(await readdir(directory, { withFileTypes: true })).length };
}

/** 列目录之后、读文件之前被删除、改名或换成目录的候选。 */
function vanished(error: unknown): boolean {
  return isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR") || isErrno(error, "EISDIR");
}

/**
 * 从目录非递归地均匀抽一张图片并读出字节。候选口径见 randomImageNames。抽中的文件超过
 * RANDOM_IMAGE_MAX_BYTES（只看 stat，不读入内存），或在读取前已消失（部署方正在整理目录）
 * 时，都从剩余候选里剔除后重新均匀抽取，最多尝试候选数那么多次，所以图库里混进几张超限
 * 文件不影响抽到其余的图。候选抽完仍无可发送的图时，这一轮抽中过超限文件就报 tooLarge 并
 * 点名最后那个，否则报 empty。
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
  let oversized: string | undefined;
  for (let fileName: string | undefined = pickRandom(candidates); fileName !== undefined; fileName = pickRandom(candidates)) {
    const path: string = join(directory, fileName);
    try {
      if ((await Bun.file(path).stat()).size > RANDOM_IMAGE_MAX_BYTES) {
        oversized = fileName;
      } else {
        const mimeType: RandomImageMimeType = RANDOM_IMAGE_EXTENSIONS.get(extname(fileName).toLowerCase())!;
        return { status: "ok", bytes: await Bun.file(path).bytes(), mimeType, fileName };
      }
    } catch (error: unknown) {
      if (!vanished(error)) throw error;
    }
    candidates.splice(candidates.indexOf(fileName), 1);
  }
  return oversized === undefined ? { status: "empty" } : { status: "tooLarge", fileName: oversized };
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
 * 把一张图写进图库：按字节嗅探格式（只收 jpeg、png、webp），文件名取内容的 SHA-256
 * 加保存扩展名。先写点号开头的临时文件，再在同一目录内改名为正式文件名，抽图永远看不到
 * 写到一半的文件。写入或改名失败时删除临时文件并原样上抛。
 *
 * 目标已存在时直接报 existing，不读其内容、不重复写盘；手工文件也必须遵守内容摘要命名。
 * 同一张图无论由谁转发、`file_unique_id` 是否相同，都落到同一个文件名。
 * 判存在与改名之间没有加锁：这段窗口里唯一可能发生的是另一路写入同一份字节，改名覆盖的是
 * 逐字节相同的内容，结果与不覆盖一致。
 * @param directory 已解析成绝对路径的图库目录。
 * @param bytes 完整的图片字节。
 */
export async function storeRandomImage(
  directory: string,
  bytes: Uint8Array
): Promise<StoreRandomImageResult> {
  const extension: string | undefined = RANDOM_IMAGE_SAVE_EXTENSIONS.get(sniffImageFormat(bytes));
  if (extension === undefined) return { status: "unsupportedFormat" };
  const fileName: string = `${Bun.SHA256.hash(bytes, "hex")}${extension}`;
  const target: string = join(directory, fileName);
  if (await Bun.file(target).exists()) return { status: "existing", fileName };
  const temporary: string = join(directory, `${RANDOM_IMAGE_TEMP_PREFIX}${Bun.randomUUIDv7()}${extension}`);
  try {
    await Bun.write(temporary, bytes);
    await rename(temporary, target);
  } catch (error: unknown) {
    await Bun.file(temporary).delete().catch((): undefined => undefined);
    throw error;
  }
  return { status: "stored", fileName };
}
