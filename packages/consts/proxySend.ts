/**
 * `/send` 代发会话里 TTS 请求（packages/auto/message/proxyTts.ts）的请求形态。
 * 所属模块：/send 私聊代发。
 */

/** TTS 请求代码块里 `type` 字段的取值；其余取值的代码块按普通消息原样代发。 */
export const PROXY_TTS_REQUEST_TYPE: string = "tts";

/** TTS 请求对象允许的键；`type` 为 `tts` 却出现其它键时整条请求按格式错误拒绝。 */
export const PROXY_TTS_REQUEST_KEYS: readonly string[] = ["type", "tone", "text"];
