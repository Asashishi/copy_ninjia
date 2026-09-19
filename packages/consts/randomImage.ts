import { TELEGRAM_PHOTO_UPLOAD_MAX_BYTES } from "./telegram";
import type { RandomImageMimeType } from "../types/randomImage";

/**
 * 随机图片可选的文件扩展名（小写，含点）到上传 MIME 的映射，属 infra/randomImage.ts。
 * 目录里只有扩展名命中这张表的普通文件才是候选；比较前先把扩展名转成小写。
 */
export const RANDOM_IMAGE_EXTENSIONS: ReadonlyMap<string, RandomImageMimeType> = new Map<string, RandomImageMimeType>([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

/**
 * 随机图片单个文件的字节上限，属 infra/randomImage.ts；等于 Telegram 官方 Bot API
 * 图片上传上限。超限的抽取结果直接报超限，不读入内存。
 */
export const RANDOM_IMAGE_MAX_BYTES: number = TELEGRAM_PHOTO_UPLOAD_MAX_BYTES;

/**
 * 收图（`/h_image add`）按字节嗅探出的格式到保存扩展名，属 infra/randomImage.ts；只收这三种，
 * 保存后的文件恰好落在 RANDOM_IMAGE_EXTENSIONS 的候选规则之内。
 */
export const RANDOM_IMAGE_SAVE_EXTENSIONS: ReadonlyMap<string, string> = new Map<string, string>([
  ["jpeg", ".jpg"],
  ["png", ".png"],
  ["webp", ".webp"],
]);

/** 以文件形式发送的图片里能收进图库的 MIME，属 libs/telegramImage.ts；与 RANDOM_IMAGE_SAVE_EXTENSIONS 的格式一一对应。 */
export const RANDOM_IMAGE_DOCUMENT_MIME_TYPES: ReadonlySet<string> = new Set<string>(["image/jpeg", "image/png", "image/webp"]);

/**
 * 收图写盘时临时文件名的前缀，属 infra/randomImage.ts。以点号开头，抽图（pickRandomImage）
 * 跳过隐藏文件，写到一半的文件不会被抽中；写完后在同一目录内改名为正式文件名。
 */
export const RANDOM_IMAGE_TEMP_PREFIX: string = ".h_image-add-";

/**
 * 收进图库的文件以 Telegram 的 file_unique_id 命名，属 infra/randomImage.ts；只接受这种形态，
 * 保证它不会拼出目录分隔符或上级路径。
 */
export const RANDOM_IMAGE_FILE_UNIQUE_ID_PATTERN: RegExp = /^[A-Za-z0-9_-]{1,128}$/;
