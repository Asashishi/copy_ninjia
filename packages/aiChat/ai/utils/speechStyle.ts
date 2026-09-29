/**
 * 语音合成风格说明的拼接：配置的基础朗读风格在前，本句语气经 TTS_TONE_SEPARATOR 接在
 * 其后。Gemini 作为 `speech_metadata.style`、OpenAI audio/speech 作为 `instructions` 发送；
 * xai 协议没有风格字段，不调用本函数。
 *
 * 纯函数叶子模块，不接触任何缓存与 SDK 类型（见 AGENTS.md 的「缓存与线程归属」）。
 */

import { TTS_TONE_SEPARATOR } from "../../../consts/aiChat/voiceMessage";

/**
 * 拼出一句台词的风格说明。
 * @param baseStyle 本次请求配置快照中的基础风格。
 * @param tone 本句说话语气；缺省时只用基础风格。
 */
export function composeSpeechStyle(baseStyle: string, tone: string | undefined): string {
  return tone === undefined ? baseStyle : baseStyle + TTS_TONE_SEPARATOR + tone;
}
