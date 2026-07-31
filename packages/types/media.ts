/** 群聊媒体里可做视觉解析的三种类型：图片、贴纸、GIF（Telegram animation）。
 *  三者共用同一套「占位入缓存 -> 异步下载解析 -> 原位回填」管线（见
 *  aiChat/ai/imageDescription.ts 的 describeMedia、workers/aiChatWorker.ts 的
 *  recordChatMedia），只是占位符/提示词/描述长度各不相同。 */
export type MediaKind = "photo" | "sticker" | "animation";

/** 已选定的 Telegram 视觉素材：fileId 用于下载，宽高用于保留构图比例。 */
export interface TelegramVisionSource {
  /** 可下载的本体或缩略图 file_id。 */
  fileId: string;
  /** 原媒体的稳定去重键；使用缩略图时也保留原媒体键。 */
  fileUniqueId: string;
  /** fileId 对应素材的像素尺寸。 */
  width: number;
  height: number;
}

/** 已转成 Gemini 视觉接口可直接接收的 JPEG/PNG 字节。 */
export interface VisionImage {
  bytes: Buffer;
  mime: "image/jpeg" | "image/png";
}
