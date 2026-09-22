/** 一次 `/h_image` 请求出队后要用到的会话坐标（commands/hImage/）。 */
export interface HImageRequest {
  readonly chatId: number;
  /** 触发命令的消息；结果与失败提示都回复它。 */
  readonly messageId: number | undefined;
  /** 论坛群里触发消息所在话题；General 与非论坛群为 undefined。 */
  readonly messageThreadId: number | undefined;
}

/** 一条消息里能收进随机图库的一张图（libs/telegramImage.ts）。 */
export interface MessageImageCandidate {
  readonly fileId: string;
  /** 跨时间、跨 bot 稳定的文件标识；收进图库后写在文件名的 uuidv7 之后，也用于去重。 */
  readonly fileUniqueId: string;
  /** Telegram 给出的字节数；没给时为 undefined。 */
  readonly fileSize: number | undefined;
}

/** 相册缓存的一项（cache/main/mediaGroups.ts）：相册所在的群与已见过的图。 */
export interface MediaGroupImages {
  readonly chatId: number;
  /** 至多 MEDIA_GROUP_ITEMS_MAX 张，按 fileUniqueId 去重，按到达顺序排列。 */
  readonly items: MessageImageCandidate[];
}

/** 一次 `/h_image add` 出队后要用到的会话坐标与候选图。 */
export interface HImageAddRequest extends HImageRequest {
  readonly candidates: readonly MessageImageCandidate[];
}

/** 收一张图的结局（commands/hImage/add.ts）；stopped 表示停机取消，整批静默收场。 */
export type HImageAddOutcome = "added" | "existing" | "invalidDimensions" | "failed" | "stopped";

/** 一张图的像素尺寸（infra/image.ts 的 readImageDimensions）。 */
export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

/** `/h_image add` 收完后的汇总计数，交给 H_IMAGE_TEXTS.addResult 渲染。 */
export interface HImageAddSummary {
  /** 本次新收进图库的张数。 */
  readonly added: number;
  /** 本次收图开始前图库里的张数，口径同 `/h_image` 抽图的候选（infra/randomImage.ts）。 */
  readonly librarySize: number;
  /** 图库里早已有同一 file_unique_id、本次跳过的张数。 */
  readonly existing: number;
  /**
   * 宽高之和超过 TELEGRAM_PHOTO_MAX_DIMENSION_SUM、或长宽比超过
   * TELEGRAM_PHOTO_MAX_ASPECT_RATIO 而没收的张数。与 failed 分开记：这一档
   * 的图本身下载成功、格式也对，只是 Telegram 发不出去，回执要说清是哪一条。
   */
  readonly invalidDimensions: number;
  /** 超限、格式不对、下载失败或预算耗尽而没收成的张数。 */
  readonly failed: number;
}
