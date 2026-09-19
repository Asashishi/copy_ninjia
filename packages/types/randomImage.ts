/** 随机图片上传时声明的 MIME；只决定上传文件名的扩展名，见 consts/randomImage.ts。 */
export type RandomImageMimeType = "image/jpeg" | "image/png" | "image/webp";

/**
 * 从目录随机抽取一张图片的结果（infra/randomImage.ts 的 pickRandomImage）。
 * - ok：已读入字节；fileName 是目录内的原始文件名，只用于日志与上传文件名。
 * - missingDirectory：目录不存在或不是目录。
 * - empty：目录里没有候选图片。
 * - tooLarge：抽中的文件超过 RANDOM_IMAGE_MAX_BYTES。
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
 * 把一张图写进随机图库的结局（infra/randomImage.ts 的 storeRandomImage）：
 * - stored：已按 file_unique_id 与嗅探出的格式命名写入；
 * - unsupportedFormat：字节不是 jpeg、png 或 webp，没有写入。
 */
export type StoreRandomImageResult =
  | { readonly status: "stored"; readonly fileName: string }
  | { readonly status: "unsupportedFormat" };
