/**
 * 语音合成（TTS）这一项能力的领域类型：供应商合成结果、PCM 解码结果、Telegram 可直接
 * 发送的容器探测结果、Telegram 语音消息编码结果与公共合成入口的结果。
 *
 * 供应商只交回自己声明的容器字节（见 types/aiChat/provider.ts 的 AiSpeechProvider）；
 * WAV 解析、OGG/Opus 编码与 OGG/Opus、MP3 的校验在与供应商无关的
 * aiChat/ai/utils/wavPcm.ts、aiChat/ai/utils/voiceContainer.ts 与 aiChat/ai/voiceEncoding.ts 完成。
 */

import type { AgentProvider } from "../config";
import type { Base64PayloadDecodeFailure } from "./payload";
import type { AiMeteredSpeechRequest } from "./provider";

/**
 * 已校验大小的合成语音：容器字节与 MIME。Gemini 为响应声明的 `audio/wav`；OpenAI 与 xAI
 * 为请求时指定格式对应的 `audio/ogg`（Opus）与 `audio/mpeg`。
 */
export interface SynthesizedSpeech {
  bytes: Uint8Array;
  mimeType: string;
}

/**
 * 语音合成的每日计数：AI 与预留额度各自计数，共用窗口内第一次请求的时间戳。
 * 与 memory/global/state.json 的 `ttsUsage` 同形；每次登记都换成新对象，不原地修改。
 */
export interface TtsDailyUsage {
  /** 当前计数窗口的起点（ms），即窗口内第一次发起合成请求的时刻。 */
  readonly windowStartedAt: number;
  /** AI 语音工具已发起的请求数，非负安全整数；超过当前 AI 上限时拒绝该入口的新请求。 */
  readonly agentCount: number;
  /** `/send` 与 cron 共用的已发起请求数，非负安全整数；两项计数至少一项大于 0。 */
  readonly reserveCount: number;
}

/**
 * 一次 `operator` 口径登记的凭据：登记时所在计数窗口的起点。供应商失败时凭它退还这一次，
 * 窗口已经换代则不退（见 aiChat/ai/ttsUsage.ts 的 refundOperatorTtsUsage）。
 */
export interface TtsOperatorClaim {
  readonly windowStartedAt: number;
}

/**
 * 一次合成请求所用的独立每日额度：`operator`（`/send` 与 cron）使用 daily_reserve_quota，
 * `ai`（AI 语音工具）使用 daily_limit - daily_reserve_quota；两者互不借用额度。
 */
export type TtsQuotaScope = "ai" | "operator";

/**
 * 语音合成门面一次调用的结果：`daily limit reached` 表示这次调用没有发起供应商请求；
 * `synthesis failed` 表示供应商没交回可用音频或本地配额队列已满。
 */
export type SpeechSynthesisAttempt =
  | { readonly ok: true; readonly speech: SynthesizedSpeech }
  | { readonly ok: false; readonly reason: "synthesis failed" | "daily limit reached" };

/** 合成载荷不可用的具体原因，只用于错误日志定位（英文，见 AGENTS.md 的日志约定）。 */
export type SynthesizedSpeechDecodeFailure =
  | Base64PayloadDecodeFailure
  | "missing audio mime type"
  | "audio body exceeds the size limit";

/** 按大小与 MIME 解码合成载荷（或有界读取音频响应体）的结果；失败一律带上可记日志的原因。 */
export type SynthesizedSpeechDecodeResult =
  | { readonly ok: true; readonly speech: SynthesizedSpeech }
  | { readonly ok: false; readonly reason: SynthesizedSpeechDecodeFailure };

/** WAV 容器解析失败的具体原因，只用于错误日志定位。 */
export type WavPcmDecodeFailure =
  | "not a RIFF/WAVE container"
  | "missing fmt chunk"
  | "unsupported sample format"
  | "missing data chunk"
  | "truncated chunk"
  | "empty audio";

/** 单声道 16 bit PCM WAV 的解析结果；样本已归一到 [-1, 1)。 */
export type WavPcmDecodeResult =
  | { readonly ok: true; readonly samples: Float32Array; readonly sampleRate: number }
  | { readonly ok: false; readonly reason: WavPcmDecodeFailure };

/**
 * 供应商直接交回 Telegram 语音格式（OGG/Opus 或 MP3）时，容器校验不通过的具体原因，
 * 只用于错误日志定位。
 */
export type VoiceContainerFailure =
  | "not an Ogg Opus stream"
  | "truncated Ogg page"
  | "invalid Ogg granule position"
  | "not an MP3 stream"
  | "truncated MP3 frame";

/** 容器校验结果：通过时带向上取整的整秒时长。 */
export type VoiceContainerProbeResult =
  | { readonly ok: true; readonly durationSeconds: number }
  | { readonly ok: false; readonly reason: VoiceContainerFailure };

/** 可直接交给 Telegram sendVoice 的语音：本地编码或校验通过的 OGG/Opus，或校验通过的 MP3。 */
export interface EncodedVoiceMessage {
  /** 独占整块 ArrayBuffer；主线程转交的合成结果随回执转移这块 buffer。 */
  bytes: Uint8Array<ArrayBuffer>;
  /** 向上取整的整秒时长，填入 sendVoice 的 duration。 */
  durationSeconds: number;
  /** sendVoice 上传用的文件名，扩展名与容器一致（VOICE_OGG_FILE_NAME 或 VOICE_MP3_FILE_NAME）。 */
  fileName: string;
}

/** 语音编码失败的具体原因，只用于错误日志定位。 */
export type VoiceEncodeFailure =
  | WavPcmDecodeFailure
  | VoiceContainerFailure
  | "unsupported speech mime type"
  | "opus encoder failed";

/** 把合成语音编码成 Telegram 语音消息的结果。 */
export type VoiceEncodeResult =
  | { readonly ok: true; readonly voice: EncodedVoiceMessage }
  | { readonly ok: false; readonly reason: VoiceEncodeFailure };

/**
 * 一次「文本 + 语气 → Telegram 语音消息」没有产出语音的原因，只用于错误日志与回执
 * 分类（英文）。前两项是能力缺席（`agent.tts` 缺省、所选实现没有语音合成）；
 * `synthesis failed` 是供应商没交回可用音频（含本地配额队列已满）；`daily limit reached`
 * 是本调用方的每日额度已用尽、未发起请求；`aborted` 是调用方取消；`worker unavailable`
 * 与 `timed out` 只出现在主线程经 AI Worker 转交的请求上。
 */
export type VoiceSynthesisFailure =
  | "tts unconfigured"
  | "tts unsupported"
  | "synthesis failed"
  | "daily limit reached"
  | "aborted"
  | "worker unavailable"
  | "timed out"
  | VoiceEncodeFailure;

/** 语音合成公共实现的结果（aiChat/ai/voiceSynthesis.ts 与主线程转交 aiChat/voiceSynthesis.ts）。 */
export type VoiceSynthesisResult =
  | { readonly ok: true; readonly voice: EncodedVoiceMessage }
  | { readonly ok: false; readonly reason: VoiceSynthesisFailure };

/**
 * 本 isolate 的语音合成入口，即带每日计数的 tts 门面；只在 AI Worker 上取得（见
 * aiChat/ai/voiceSynthesis.ts）。
 */
export type SpeechSynthesizer = (request: AiMeteredSpeechRequest) => Promise<SpeechSynthesisAttempt>;

/**
 * 查找语音合成入口的结果：`agent.tts` 缺省时 providerName 为 undefined；所选实现没有
 * 语音合成时带上那一家的名字，供调用方写诊断。
 */
export type SpeechSynthesizerLookup =
  | { readonly ok: true; readonly synthesize: SpeechSynthesizer }
  | {
    readonly ok: false;
    readonly reason: "tts unconfigured" | "tts unsupported";
    readonly providerName: AgentProvider | undefined;
  };

/**
 * 随 `agent.tts.bot_language` 切换的一份语音相关文案（consts/aiChat/prompts/tools.ts 的
 * VOICE_LANGUAGE_PROMPTS 按 TtsBotLanguage 各注册一份）：回复模型可见的提示词，以及 AI 语音合成
 * 请求追加的朗读语言要求。replyToolset/orchestrator.ts 每轮取一份，工具声明、系统提示词与本轮
 * send_voice 的合成请求同用这一份。
 */
export interface VoiceLanguagePrompts {
  /** send_voice 的内置工具说明；prompt/voice_tool.md 存在时由其正文整份替换（见 replyToolset/voiceMessage.ts）。 */
  readonly sendVoiceInstruction: string;
  /** send_voice 参数 text 的说明。 */
  readonly voiceTextDescription: string;
  /** send_voice 参数 tone 的说明。 */
  readonly voiceToneDescription: string;
  /** send_message 的工具说明，含语音台词与文字的去重规则。 */
  readonly sendMessageInstruction: string;
  /** 系统提示词「行动与停止」段，含语音台词与文字的去重规则。 */
  readonly replyActionInstruction: string;
  /**
   * send_voice 合成请求在基础朗读风格之后追加的朗读语言要求，用该台词语言本身写成；只交给语音合成
   * 模型，不进回复模型的提示词，`/send` 与 cron 的合成不带它。
   */
  readonly speechLanguageStyle: string;
}
