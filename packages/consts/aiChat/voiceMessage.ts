/**
 * 语音合成公共实现（packages/aiChat/ai/voiceSynthesis.ts）与它的三个调用方——AI 语音
 * 工具、`/send` 代发的 TTS 请求、cron `send_voice`——的领域预算、默认基础风格，以及
 * Telegram 语音消息的编码参数。群聊语音转写的常量在 consts/aiChat/voice.ts。
 *
 * **模型名与音色不在这里**：走 config/dynamic/agent.json 的 `agent.tts`，代码不持有任何
 * 模型默认值（见 config/agent.ts）。超时、重试与错误标签属于供应商能力，在
 * consts/aiChat/{gemini,openai}.ts。
 *
 * 所属模块：AI 语音合成。
 */

/**
 * `agent.tts.style` 缺省时的基础朗读风格（google 与 openai 两种接受风格的协议；xai 协议不接受
 * style）。Gemini 经 `speech_metadata.style`、OpenAI 经 `instructions` 随台词提交；调用方给出
 * 本句语气时以 TTS_TONE_SEPARATOR 接在它之后（见 aiChat/ai/utils/speechStyle.ts）。
 */
export const TTS_DEFAULT_STYLE: string = "いたずらすきそうな音調が高い小悪魔の甘く、弾むようなツンデレ音色";

/** 基础朗读风格与本句语气之间的连接段，拼成 `<基础风格>; 细节: <语气，其他要求>`。 */
export const TTS_TONE_SEPARATOR: string = "; 细节: ";

/**
 * `agent.tts.daily_limit` 缺省时的每日总预算：每个窗口拆为 AI 与预留两份独立额度。
 * 计数在 AI Worker 的语音合成门面发起请求前登记（见 aiChat/ai/ttsUsage.ts），窗口与
 * 次数持久化在 memory/global/state.json 的 `ttsUsage`。
 */
export const TTS_DEFAULT_DAILY_LIMIT: number = 100;

/**
 * `agent.tts.daily_reserve_quota` 缺省时从每日上限里留给 `/send` 代发 TTS 与 cron
 * `send_voice` 共用的独立次数；AI 使用另外的 `daily_limit - daily_reserve_quota` 次，
 * 两边分别计数、互不借用；提示词与工具回执只扣 AI 已用次数。
 */
export const TTS_DEFAULT_DAILY_RESERVE_QUOTA: number = 25;

/**
 * 计数窗口长度（ms）。窗口从当前窗口内第一次请求起算；登记时距窗口起点已满本值，
 * 就以这次请求为新起点，两项计数清零后只登记本次请求所属的那一项。
 */
export const TTS_USAGE_WINDOW_MS: number = 86_400_000;

/** 语音工具单轮最多接纳一条语音；接纳时同时预占一个共享可见动作。 */
export const MAX_VOICES_PER_REPLY: number = 1;

/**
 * AI 语音工具等待合成结果的前台窗口（ms），从工具调用起算：工具回执与串行动作链上的语音
 * 步骤都最多等到这里。窗口内合成结束时回执给真实结果，链上按调用顺序投递；到点仍未结束时
 * 回执标明仍在合成，链上收回「正在录音」并把投递转入后台，链继续执行后续步骤。合成自身的
 * 超时不受本值影响（consts/aiChat/gemini.ts 的 GEMINI_SPEECH_REQUEST_TIMEOUT_MS、
 * consts/aiChat/openai.ts 的 OPENAI_SPEECH_REQUEST_TIMEOUT_MS）。所属模块：
 * aiChat/ai/tools/replyToolset/voiceMessage.ts。
 */
export const VOICE_FOREGROUND_WAIT_MS: number = 25_000;

/**
 * 模型交给语音合成的台词最大字符数；约束在一两句短台词的量级。编码在 AI Worker
 * 线程上同步执行、耗时随时长线性增长，这个上限同时约束单次编码占用线程的时长。
 */
export const VOICE_TEXT_MAX_CHARS: number = 64;

/**
 * 模型为单句台词追加的说话语气描述的最大字符数。语气拼在基础朗读风格之后作为
 * 本句的风格说明（见 aiChat/ai/utils/speechStyle.ts），只描述这一句怎么说；xai 协议
 * 没有风格指令字段，不发送语气。
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
 * 包含配额排队、供应商请求与编码；供应商请求及其重试共用一个取消信号
 * （consts/aiChat/gemini.ts 的 GEMINI_SPEECH_REQUEST_TIMEOUT_MS、consts/aiChat/openai.ts 的
 * OPENAI_SPEECH_REQUEST_TIMEOUT_MS），尝试次数不延长该预算。到点按失败结算，并通知 Worker
 * 取消这次合成。
 */
export const VOICE_SYNTHESIS_REQUEST_TIMEOUT_MS: number = 240_000;

/**
 * 合成结果解码后的最大字节数。24 kHz 单声道 16 bit PCM 每秒约 48 KB，8 MiB
 * 约合 175 秒；按完整音频载荷校验，包含容器头；OGG/Opus 与 MP3 即响应体字节数。
 */
export const VOICE_SPEECH_MAX_BYTES: number = 8 * 1_024 * 1_024;

/** 标准 base64 对二进制上限的理论编码长度，用于在解码分配内存前拒绝超大响应。 */
export const VOICE_SPEECH_MAX_ENCODED_CHARS: number = Math.ceil(VOICE_SPEECH_MAX_BYTES / 3) * 4;

/**
 * OGG/Opus 语音的上传文件名：发到 Telegram 的语音（本地编码结果与 OpenAI `opus` 响应），以及
 * 交给 OpenAI 兼容转写接口的群语音（aiChat/openai/text.ts）。sendVoice 显示为语音气泡只接受
 * OGG/Opus、MP3 与 M4A，扩展名与容器一致。
 */
export const VOICE_OGG_FILE_NAME: string = "voice.ogg";

/** MP3 语音上传到 Telegram 的文件名（xAI `mp3` 响应）。 */
export const VOICE_MP3_FILE_NAME: string = "voice.mp3";

/** Opus 编码目标码率（kbps），用于供应商合成的 24 kHz 单声道人声。 */
export const VOICE_OPUS_BITRATE_KBPS: number = 48;

/** Opus 编码器的计算档位（0～10），档位越高单次编码占用 AI Worker 线程越久。 */
export const VOICE_OPUS_COMPLEXITY: number = 5;

/** Opus 编码的应用档位；`audio` 以保真为先，不加 `voip` 档的语音高通处理。 */
export const VOICE_OPUS_APPLICATION: "voip" | "audio" | "lowdelay" = "audio";
