/**
 * 语音合成公共实现（packages/aiChat/ai/voiceSynthesis.ts）与它的三个调用方——AI 语音
 * 工具、`/send` 代发的 TTS 请求、cron `send_voice`——的领域预算，以及 Telegram 语音
 * 消息的编码参数。群聊语音转写的常量在 consts/aiChat/voice.ts。
 *
 * **模型名不在这里**：走 config/dynamic/agent.json 的 `agent.tts`，代码不持有任何模型
 * 默认值（见 config/agent.ts）。音色、风格、超时与错误标签属于供应商能力，在
 * consts/aiChat/gemini.ts。
 *
 * 所属模块：AI 语音合成。
 */

/**
 * `agent.tts.daily_limit` 缺省时的每日上限：每个计数窗口内三个调用方共用的供应商请求数。
 * 计数在 AI Worker 的语音合成门面发起请求前登记（见 aiChat/ai/ttsUsage.ts），窗口与
 * 次数持久化在 memory/global/state.json 的 `ttsUsage`。
 */
export const TTS_DEFAULT_DAILY_LIMIT: number = 100;

/**
 * `agent.tts.daily_reserve_quota` 缺省时从每日上限里留给 `/send` 代发 TTS 与 cron
 * `send_voice` 的次数；AI 语音工具只能用到 `daily_limit - daily_reserve_quota`，
 * 提示词与工具回执里的余量同样按它计算。
 */
export const TTS_DEFAULT_DAILY_RESERVE_QUOTA: number = 25;

/**
 * 计数窗口长度（ms）。窗口从当前窗口内第一次请求起算；登记时距窗口起点已满本值，
 * 就以这次请求为新起点从 1 重新计数。
 */
export const TTS_USAGE_WINDOW_MS: number = 86_400_000;

/** 语音工具单轮最多接纳一条语音；接纳时同时预占一个共享可见动作。 */
export const MAX_VOICES_PER_REPLY: number = 1;

/**
 * 模型交给语音合成的台词最大字符数；约束在一两句短台词的量级。编码在 AI Worker
 * 线程上同步执行、耗时随时长线性增长，这个上限同时约束单次编码占用线程的时长。
 */
export const VOICE_TEXT_MAX_CHARS: number = 64;

/**
 * 模型为单句台词追加的说话语气描述的最大字符数。语气拼在基础朗读风格之后作为
 * 本句的风格说明（见 aiChat/gemini/speech.ts），只描述这一句怎么说。
 */
export const VOICE_TONE_MAX_CHARS: number = 64;

/**
 * 运维直接给出的台词（`/send` 代发的 TTS 请求与 cron `send_voice` 的 content）的最大
 * 字符数；由两个入口按字符串长度校验。AI 自主语音台词使用 VOICE_TEXT_MAX_CHARS，
 * 语气上限共用 VOICE_TONE_MAX_CHARS。编码同步占用 AI Worker 的时长随音频时长增加。
 */
export const VOICE_OPERATOR_TEXT_MAX_CHARS: number = 256;

/**
 * 主线程等待 AI Worker 交回一次合成结果的上限（packages/aiChat/voiceSynthesis.ts）。
 * 包含配额排队、供应商请求与编码；供应商 SDK 调用及其重试共用 60 秒取消信号
 * （consts/aiChat/gemini.ts 的 GEMINI_SPEECH_REQUEST_TIMEOUT_MS），尝试次数不延长该预算。
 * 到点按失败结算，并通知 Worker 取消这次合成。
 */
export const VOICE_SYNTHESIS_REQUEST_TIMEOUT_MS: number = 240_000;

/**
 * 合成结果解码后的最大字节数。24 kHz 单声道 16 bit PCM 每秒约 48 KB，8 MiB
 * 约合 175 秒；按完整音频载荷校验，包含 WAV 容器头。
 */
export const VOICE_SPEECH_MAX_BYTES: number = 8 * 1_024 * 1_024;

/** 标准 base64 对二进制上限的理论编码长度，用于在解码分配内存前拒绝超大响应。 */
export const VOICE_SPEECH_MAX_ENCODED_CHARS: number = Math.ceil(VOICE_SPEECH_MAX_BYTES / 3) * 4;

/** 发送到 Telegram 的语音文件名；sendVoice 显示为语音气泡要求 OGG/Opus 容器。 */
export const VOICE_FILE_NAME: string = "voice.ogg";

/** Opus 编码目标码率（kbps），用于供应商合成的 24 kHz 单声道人声。 */
export const VOICE_OPUS_BITRATE_KBPS: number = 48;

/** Opus 编码器的计算档位（0～10），档位越高单次编码占用 AI Worker 线程越久。 */
export const VOICE_OPUS_COMPLEXITY: number = 5;

/** Opus 编码的应用档位；`audio` 以保真为先，不加 `voip` 档的语音高通处理。 */
export const VOICE_OPUS_APPLICATION: "voip" | "audio" | "lowdelay" = "audio";
