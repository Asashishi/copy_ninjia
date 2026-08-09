/**
 * 群聊语音转写（Telegram voice note）的领域常量：占位文案、字数与体积上限、
 * 可接收的音频容器。
 *
 * **模型名不在这里**：语音走 config/agent.json 的 `agent.media`（与图片/贴纸/GIF
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
 * 转写文本入缓存前的截断上限。
 *
 * 比图片描述宽得多：图片那条是「模型对画面的概括」，长了就是啰嗦；语音这条是
 * **群友原话**，截断等于把人话说了一半，模型据此接话会答非所问。上限只用来防
 * 单条超长语音把整个热区挤爆。
 */
export const VOICE_TRANSCRIPT_MAX_CHARS: number = 1_024;

/**
 * 单条语音允许读入内存并内联进请求的最大字节数。
 *
 * 明显小于 MEDIA_MAX_DOWNLOAD_BYTES（16 MiB）：音频是 base64 内联发给模型的，
 * 编码后要涨 4/3，而 Gemini 的单次内联请求总大小上限是 20 MB——按 16 MiB 放行会
 * 编出 21 MB 以上、整条请求被服务端拒收，观感上就是「长语音一律识别失败」。
 * 8 MiB 编码后约 10.7 MiB；正常 voice note 通常先撞下面的时长上限，这道硬顶
 * 主要防异常码率或异常容器把请求体与 Worker 内存拉爆。
 */
export const VOICE_MAX_DOWNLOAD_BYTES: number = 8 * 1_024 * 1_024;

/**
 * 允许送去转写的最长语音时长（秒）。
 *
 * 与字节上限各挡一头：字节挡的是请求体，这个挡的是 token 账单与延迟（音频按
 * 32 token/秒计费，512 秒约为 8 分 32 秒、16 384 token，且转写要等完整下载 +
 * 一次长请求）。
 * 超时长的语音在主线程就不进媒体管线，直接按「[语音 N 秒]」记一行文字，见
 * auto/message/voice.ts。
 */
export const VOICE_MAX_DURATION_SECONDS: number = 512;

/**
 * 可直接内联给多模态模型的音频容器白名单（Gemini 官方支持清单的子集）。
 *
 * Telegram voice note 恒为 OGG/Opus，白名单只是用来把 Telegram 声明的
 * `mime_type` 归一——声明缺失或写了别的容器时一律退回 VOICE_DEFAULT_MIME，不
 * 把一个没验证过的字符串原样转发给模型。只读数组类型防止调用方误改（不可变性
 * 只在编译期表达，见 AGENTS.md 的「常量」一节）。
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
