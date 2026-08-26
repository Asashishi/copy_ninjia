/** 群聊媒体里可做异步解析的四种类型：图片、贴纸、GIF（Telegram animation）、
 *  语音（Telegram voice）。四者共用同一套「占位入缓存 -> 异步下载解析 -> 原位
 *  回填」管线（见 aiChat/ai/imageDescription.ts 的 describeMedia、
 *  workers/aiChat/mediaIngest.ts 的 recordChatMedia），只是占位符/提示词/长度上限
 *  各不相同。
 *
 *  前三种走视觉理解，语音走语音转写：解析入口同一个，底下的下载与模型调用分成
 *  两条（见 aiChat/ai/voiceTranscription.ts）。语音记录不带像素尺寸，两个尺寸字段
 *  恒为 0——协议形状必须保持单一隐藏类，不为一种媒体单开一套载荷（见
 *  types/aiChat/protocol.ts 的 AiRecordMediaMessage）。 */
export type MediaKind = "photo" | "sticker" | "animation" | "voice";

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

/** 已转成两家供应商视觉接口都能直接接收的 JPEG/PNG 字节。 */
export interface VisionImage {
  bytes: Uint8Array;
  mime: "image/jpeg" | "image/png";
}

/**
 * Telegram 语音消息按原样取回的音频字节。
 *
 * **不转码**：Telegram 的 voice note 固定是 OGG/Opus，而 Gemini 的多模态理解本来
 * 就收 `audio/ogg`（见 consts/aiChat/voice.ts 的 VOICE_MIME_TYPES）。图片那条线要
 * 转码是因为两家视觉接口只认 jpg/png，这里没有对等约束，转一道只会白烧 CPU 并
 * 引入一层可能失败的依赖。
 */
export interface VoiceClip {
  bytes: Uint8Array;
  /** 供应商可接收的音频 mime；取自 Telegram 声明并经白名单归一。 */
  mime: string;
  /** Telegram 声明的时长（秒），用于诊断与转写提示词里的长度提示。 */
  durationSeconds: number;
}
