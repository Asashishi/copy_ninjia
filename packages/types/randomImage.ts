/** 随机图片上传时声明的 MIME；只决定上传文件名的扩展名，见 consts/randomImage.ts。 */
export type RandomImageMimeType = "image/jpeg" | "image/png" | "image/webp";

/**
 * 从目录随机抽取一张图片的结果（infra/randomImage.ts 的 pickRandomImage）。
 * - ok：已读入字节；fileName 是目录内的原始文件名，只用于日志与上传文件名。
 * - missingDirectory：目录不存在或不是目录。
 * - empty：目录里没有候选图片。
 * - tooLarge：候选都抽过了仍没有可发送的图，且其中至少一张超过 RANDOM_IMAGE_MAX_BYTES；
 *   fileName 是最后抽中的那张超限文件，只用于提示部署方处理。
 */
export type RandomImagePick =
  | {
    readonly status: "ok";
    readonly bytes: Uint8Array;
    readonly mimeType: RandomImageMimeType;
    readonly fileName: string;
  }
  | { readonly status: "missingDirectory" }
  | { readonly status: "empty" }
  | { readonly status: "tooLarge"; readonly fileName: string };

/**
 * 图库的一次候选计数（infra/randomImage.ts 的 readRandomImageLibrary），不包含去重索引。
 */
export interface RandomImageLibrary {
  /** 图库里的图片张数，口径同 pickRandomImage 的候选。 */
  readonly size: number;
}

/**
 * 把一张图写进随机图库的结局（infra/randomImage.ts 的 storeRandomImage）：
 * - stored：已按 `<内容 SHA-256><扩展名>` 写入，扩展名由字节嗅探得出；
 * - existing：按内容摘要和扩展名计算的目标已存在，没有读取旧内容或重复写入；
 * - unsupportedFormat：字节不是 jpeg、png 或 webp，没有写入。
 */
export type StoreRandomImageResult =
  | { readonly status: "stored"; readonly fileName: string }
  | { readonly status: "existing"; readonly fileName: string }
  | { readonly status: "unsupportedFormat" };
