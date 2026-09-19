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
 * 图片上传上限（10 MB）。超限的抽取结果直接报超限，不读入内存。
 */
export const RANDOM_IMAGE_MAX_BYTES: number = 10 * 1024 * 1024;
