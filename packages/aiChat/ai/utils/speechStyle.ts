/**
 * 语音合成风格说明的拼接：配置的基础朗读风格在前，朗读语言要求经 TTS_LANGUAGE_SEPARATOR、本句语气经
 * TTS_TONE_SEPARATOR 依次接在其后。Gemini 作为 `speech_metadata.style`、OpenAI audio/speech 作为
 * `instructions` 发送；xai 协议没有风格字段，不调用本函数。
 *
 * 纯函数叶子模块，不接触任何缓存与 SDK 类型（见 AGENTS.md 的「缓存与线程归属」）。
 */

import { TTS_LANGUAGE_SEPARATOR, TTS_TONE_SEPARATOR } from "../../../consts/aiChat/voiceMessage";

/**
 * 拼出一句台词的风格说明。
 * @param baseStyle 本次请求配置快照中的基础风格。
 * @param languageStyle 朗读语言要求；只有 AI 回复的合成请求带，缺省时不拼。
 * @param tone 本句说话语气；缺省时不拼。
 */
export function composeSpeechStyle(
  baseStyle: string,
  languageStyle: string | undefined,
  tone: string | undefined
): string {
  const style: string = languageStyle === undefined
    ? baseStyle
    : baseStyle + TTS_LANGUAGE_SEPARATOR + languageStyle;
  return tone === undefined ? style : style + TTS_TONE_SEPARATOR + tone;
}
