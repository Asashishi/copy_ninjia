/**
 * 群聊语音转写（Telegram voice note）的领域常量：占位文案、字数与体积上限、
 * 可接收的音频容器。
 *
 * **模型名不在这里**：语音走 config/dynamic/agent.json 的 `agent.media`（与图片/贴纸/GIF
 * 的视觉理解共用一项能力），代码不持有任何模型默认值，见 config/agent.ts。
 * 输出 token 上限属于供应商实现，在 consts/aiChat/{gemini,openai}.ts。
 * 所属模块：packages/aiChat/ai/voiceTranscription.ts 与 workers/aiChat/mediaText.ts。
 */

/** 语音转写请求在错误日志里的调用名；供应商中立。 */
export const VOICE_TRANSCRIPTION_ERROR_LABEL: string = "AI voice transcription API";

/** 语音转写尚未落定时进入转录的占位。 */
export const VOICE_PENDING_PLACEHOLDER: string = "[语音：识别中]";
/** 语音转写最终失败时替换进转录的占位。 */
export const VOICE_FALLBACK_PLACEHOLDER: string = "[语音：没听清，请无视此消息]";

/**
 * 转写文本入缓存前的截断上限，宽于图片描述；转写是**群友原话**，
 * 上限只约束单条超长语音占用的热区。
 */
export const VOICE_TRANSCRIPT_MAX_CHARS: number = 1_024;

/**
 * 单条语音允许读入内存并内联进请求的最大字节数。
 *
 * 音频与图片一样 base64 内联发给模型，编码后加
 * MEDIA_INLINE_PROMPT_RESERVE_BYTES 必须不超过 MEDIA_INLINE_REQUEST_MAX_BYTES（见
 * consts/aiChat/media.ts），并低于视觉上限 MEDIA_MAX_DOWNLOAD_BYTES；
 * 正常 voice note 先达到 VOICE_MAX_DURATION_SECONDS，本值约束异常码率或异常容器。
 */
export const VOICE_MAX_DOWNLOAD_BYTES: number = 8 * 1_024 * 1_024;

/**
 * 允许送去转写的最长语音时长（秒）。
 *
 * 与字节上限各约束一头：字节上限约束请求体，本值约束 token 用量与延迟。
 * 超时长的语音在主线程就不进媒体管线，直接按「[语音 N 秒]」记一行文字，见
 * auto/message/voice.ts。
 */
export const VOICE_MAX_DURATION_SECONDS: number = 512;

/**
 * 可直接内联给多模态模型的音频容器白名单（Gemini 官方支持清单的子集）。
 *
 * 白名单用来归一 Telegram 声明的 `mime_type`：声明缺失或不在白名单内时
 * 一律退回 VOICE_DEFAULT_MIME。
 */
export const VOICE_MIME_TYPES: readonly string[] = [
  "audio/ogg",
  "audio/mp3",
  "audio/mpeg",
  "audio/wav",
  "audio/aac",
  "audio/flac",
];

/** Telegram 未声明或声明了白名单外容器时使用的 mime；voice note 恒为 OGG/Opus。 */
export const VOICE_DEFAULT_MIME: string = "audio/ogg";
