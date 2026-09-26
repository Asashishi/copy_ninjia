/**
 * 语音合成（TTS）这一项能力的领域类型：供应商合成结果、PCM 解码结果、
 * Telegram 语音消息编码结果与公共合成入口的结果。
 *
 * 供应商只交回自己声明的容器字节（见 types/aiChat/provider.ts 的
 * AiSpeechProvider）；WAV 解析与 OGG/Opus 编码在与供应商无关的
 * aiChat/ai/utils/wavPcm.ts 与 aiChat/ai/voiceEncoding.ts 完成。
 */

import type { AgentProvider } from "../config";
import type { Base64PayloadDecodeFailure } from "./payload";
import type { AiMeteredSpeechRequest } from "./provider";

/** 已校验大小的合成语音：容器字节与供应商声明的 MIME。 */
export interface SynthesizedSpeech {
  bytes: Uint8Array;
  mimeType: string;
}

/**
 * 语音合成的每日计数：当前窗口内第一次请求的时间戳与窗口内已发起的请求数。
 * 与 memory/global/state.json 的 `ttsUsage` 同形；每次登记都换成新对象，不原地修改。
 */
export interface TtsDailyUsage {
  /** 当前计数窗口的起点（ms），即窗口内第一次发起合成请求的时刻。 */
  readonly windowStartedAt: number;
  /**
   * 窗口内已发起的合成请求数，正整数。`agent.tts.daily_limit` 调低后可能大于新上限，
   * 此时窗口内的请求一律按额度用尽拒绝。
   */
  readonly count: number;
}

/**
 * 一次合成请求所用的每日额度口径：`operator`（`/send` 代发与 cron `send_voice`）可用到
 * `agent.tts.daily_limit`；`ai`（AI 语音工具）只能用到 `daily_limit - daily_reserve_quota`。
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
  | "missing audio mime type";

/** 按大小与 MIME 解码合成载荷的结果；失败一律带上可记日志的原因。 */
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

/** 可直接交给 Telegram sendVoice 的 OGG/Opus 语音。 */
export interface EncodedVoiceMessage {
  /** 独占整块 ArrayBuffer；主线程转交的合成结果随回执转移这块 buffer。 */
  bytes: Uint8Array<ArrayBuffer>;
  /** 向上取整的整秒时长，填入 sendVoice 的 duration。 */
  durationSeconds: number;
}

/** 语音编码失败的具体原因，只用于错误日志定位。 */
export type VoiceEncodeFailure =
  | WavPcmDecodeFailure
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
