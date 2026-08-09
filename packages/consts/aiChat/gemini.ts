/**
 * Gemini 实现包（packages/aiChat/gemini/）独占的常量：请求超时、SDK 重试次数、
 * 分辨率档位与内容过滤档位。
 *
 * **模型名不在这里**：provider=google 的能力从 config/agent.json 各自读取 model
 * 与可选 base_url，代码不持有任何模型默认值（见 config/agent.ts）。
 *
 * 与供应商无关的预算（工具轮数、动作上限、采样温度、token 上限）留在
 * consts/aiChat/tools.ts 与各领域 consts 里——换供应商时那些数不该跟着动。
 * 所属模块：packages/aiChat/gemini/。
 */

import { HarmBlockThreshold, HarmCategory } from "@google/genai";
import type { SafetySetting } from "@google/genai";

/** 生图请求固定的分辨率档位；该模型只支持这一档，不做成可变参数。 */
export const GEMINI_IMAGE_SIZE: string = "1K";

/**
 * 闲聊回复生成温度：略高于中性，保留人设发挥。
 *
 * 采样温度是供应商能力，不是领域策略：OpenAI 侧的 GPT-5 系推理模型只接受默认
 * 温度，那边根本不发送这个参数。放在共享 consts 里会让「这个数对两家都成立」
 * 成为一句假话。
 */
export const GEMINI_REPLY_TEMPERATURE: number = 1.0;
/** 本轮已观测到服务端搜索后，后续工具轮改用的温度：高温对事实忠实度的伤害
 *  比提示词措辞更大，查证过的轮次压低采样随机性，让模型照搜索结果讲。
 *  注意搜索与首次成文发生在同一次请求里，那一轮仍按 GEMINI_REPLY_TEMPERATURE 生成。 */
export const GEMINI_GROUNDED_REPLY_TEMPERATURE: number = 0.7;
/** 冷消息压缩与贴纸整包简介共用的总结温度。 */
export const GEMINI_SUMMARY_TEMPERATURE: number = 0.5;

/**
 * 各流水线的输出 token 上限。这几个数同样是供应商能力而非领域策略——上限要
 * 覆盖的是该模型的思考消耗，换模型就得重新估；产出该多长由领域侧的字符上限
 * （SUMMARY_MAX_CHARS 等）约束，那才是两家通用的。
 *
 * 回复这一档包含思考 token。
 */
export const GEMINI_REPLY_MAX_TOKENS: number = 65_536;
/** 冷消息压缩摘要请求的输出 token 上限。 */
export const GEMINI_CHAT_SUMMARY_MAX_TOKENS: number = 49_152;
/** 贴纸整包简介请求的输出 token 上限。 */
export const GEMINI_STICKER_PACK_SUMMARY_MAX_TOKENS: number = 4_096;
/** 单次媒体描述请求的输出 token 上限。 */
export const GEMINI_MEDIA_DESCRIPTION_MAX_TOKENS: number = 8_192;
/**
 * 单次语音转写请求的输出 token 上限。
 *
 * 高于媒体描述那一档：转写要逐字还原群友原话，一段几分钟的语音正文本身就能顶到
 * 几千 token，再叠上思考消耗；卡在描述那一档等于让长语音稳定被 MAX_TOKENS 腰斩。
 */
export const GEMINI_VOICE_TRANSCRIPTION_MAX_TOKENS: number = 16_384;

/** 回复往返在错误日志里的调用名，用于区分是哪条流水线出的错。 */
export const GEMINI_REPLY_ERROR_LABEL: string = "Gemini API";
/** 生图请求在错误日志里的调用名。 */
export const GEMINI_IMAGE_ERROR_LABEL: string = "Gemini image generation API";
/** 生歌请求在错误日志里的调用名。 */
export const GEMINI_SONG_ERROR_LABEL: string = "Gemini song generation API";

/**
 * 单次生歌请求的超时上限。
 *
 * 独立于 GEMINI_REQUEST_TIMEOUT_MS：生歌走的是 Interactions API 的另一条端点，
 * 一首整曲要合成几分钟量级的 44.1 kHz 立体声音频，按常规请求那 150 秒的预算发
 * 会稳定超时——而超时是在**服务端已经开始出账**之后发生的，等于每次都花钱换一次
 * 失败。SDK 的 next-gen 客户端只继承构造期的 `httpOptions.timeout`，因此这一档
 * 必须在每次调用时显式传入（见 aiChat/gemini/song.ts）。
 */
export const GEMINI_SONG_REQUEST_TIMEOUT_MS: number = 600_000;

/**
 * 生歌请求的总尝试次数（含首次）。
 *
 * 刻意是 1（不重试）：一次生成就是一次计费，而失败多半来自内容过滤或配额，重试
 * 只是再买一次同样的失败。瞬时网络抖动造成的损失由调用方那一层的冷却核销策略
 * 承担，见 replyToolset/songGeneration.ts。
 */
export const GEMINI_SONG_REQUEST_ATTEMPTS: number = 1;

/** 单次 Gemini 请求的 per-attempt 超时上限。 */
export const GEMINI_REQUEST_TIMEOUT_MS: number = 150_000;
/**
 * Gemini SDK 对 408/429/5xx 的总尝试次数（首次加最多五次重试）；显式传入才能
 * 启用 SDK 2.12.0 的 retryOptions，所有调用方不得再重试这类请求失败。
 */
export const GEMINI_REQUEST_RETRY_ATTEMPTS: number = 6;

/**
 * 所有 Gemini 请求统一携带的内容过滤设置；应用不按可调概率等级主动拒绝，
 * 仍受 API 不可关闭的核心安全策略约束。数组与条目字段都由只读类型锁住，避免
 * 调用方漂移（不可变性只在编译期表达，见 AGENTS.md 的「常量」一节）。
 *
 * 这一档没有跨供应商对等物：OpenAI 侧的文本安全策略不可调（见
 * consts/aiChat/openai.ts 的模块头注），降级到 OpenAI 时回复口径会随之收紧。
 */
export const GEMINI_SAFETY_SETTINGS: readonly Readonly<SafetySetting>[] = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];
