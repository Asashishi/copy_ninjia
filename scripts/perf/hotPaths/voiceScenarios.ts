/**
 * 语音合成公共实现与 `/send` 代发 TTS 判定的热点场景。
 *
 * voice-message-encode 量的是 AI 语音工具、`/send` 代发 TTS 与 cron `send_voice` 共用的
 * 那一段（aiChat/ai/voiceSynthesis.ts 的 synthesizeVoiceMessage）：供应商交回 WAV 之后的
 * 解析与 Opus 编码，这段在 AI Worker 线程上同步占用 CPU；供应商用固定 WAV 的替身。
 * proxy-tts-detect 量的是 `/send` 代发会话里每条私聊消息都要先过的 TTS 判定，按普通
 * 文字、非 TTS 代码块与 TTS 请求三种消息轮转。
 */

import { encodeVoiceMessage } from "../../../packages/aiChat/ai/voiceEncoding";
import { synthesizeVoiceMessage } from "../../../packages/aiChat/ai/voiceSynthesis";
import { decodeWavPcm } from "../../../packages/aiChat/ai/utils/wavPcm";
import { parseProxyTtsRequest } from "../../../packages/auto/message/proxyTts";
import { VOICE_SPEECH_MAX_BYTES } from "../../../packages/consts/aiChat/voiceMessage";
import { benchmarkWav } from "../wavFixture";
import type { Message } from "grammy/types";
import type { AiSpeechRequest } from "../../../packages/types/aiChat/provider";
import type { SynthesizedSpeech, VoiceSynthesisResult } from "../../../packages/types/aiChat/voiceMessage";
import type { Scenario } from "./types";

/** 合成上限的 1/64：24 kHz 单声道 16 bit 下约 2.7 秒，一两句台词的量级。 */
const VOICE_ENCODE_PCM_BYTES: number = VOICE_SPEECH_MAX_BYTES / 64;

/** 固定 WAV 替身交给公共实现，逐次核对产出的是 OGG 容器。 */
export function voiceMessageEncodeScenario(): Scenario {
  const speech: SynthesizedSpeech = { bytes: benchmarkWav(VOICE_ENCODE_PCM_BYTES), mimeType: "audio/wav" };
  const synthesize = (_request: AiSpeechRequest): Promise<SynthesizedSpeech> => Promise.resolve(speech);
  const request: AiSpeechRequest = { text: "性能基准台词", tone: "小声で" };
  return {
    iterations: 24,
    warmupIterations: 24,
    profileRequiresOptimizedJit: false,
    run: async (iterations: number): Promise<number> => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index++) {
        const result: VoiceSynthesisResult = await synthesizeVoiceMessage(synthesize, request, "benchmark");
        if (!result.ok || result.voice.bytes[0] !== 0x4f) throw new Error("Voice encode fixture produced no OGG voice.");
        checksum += result.voice.bytes.length + result.voice.durationSeconds;
      }
      return checksum;
    },
    probes: { synthesizeVoiceMessage, encodeVoiceMessage, decodeWavPcm },
  };
}

/** 构造一条超管私聊消息；给出 entities 时表示整条是代码块。 */
function privateMessage(text: string, codeBlock: boolean): Message {
  return {
    message_id: 1,
    date: 0,
    chat: { id: 1, type: "private", first_name: "admin" },
    from: { id: 1, is_bot: false, first_name: "admin" },
    text,
    entities: codeBlock ? [{ type: "pre", offset: 0, length: text.length, language: "json" }] : undefined,
  };
}

/** 三种消息轮转；逐次核对判定结果没有漂移。 */
export function proxyTtsDetectScenario(): Scenario {
  const request: string = `{
  "type": "tts",
  "tone": "眠そうに小声で", // 拼在基础语气之后
  "text": "今晚也早点睡吧，明天见。",
}`;
  const messages: readonly Message[] = [
    privateMessage("今晚八点开会，大家别迟到。", false),
    privateMessage("const answer: number = 42;", true),
    privateMessage(request, true),
  ];
  const expected: readonly string[] = ["none", "none", "tts"];
  return {
    iterations: 600_000,
    warmupIterations: 600_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index++) {
        const slot: number = index % messages.length;
        const kind: string = parseProxyTtsRequest(messages[slot]!).kind;
        if (kind !== expected[slot]) throw new Error("Proxy TTS detection drifted.");
        checksum += kind.length;
      }
      return checksum;
    },
    probes: { parseProxyTtsRequest },
  };
}
