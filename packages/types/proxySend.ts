/** `/send` 私聊代发的领域类型。 */

/**
 * 一条私聊消息作为 TTS 请求的解析结果（packages/auto/message/proxyTts.ts）：`none` 照常
 * 代发，`invalid` 是格式错误的 TTS 请求，`tts` 带清洗后的台词与语气（未给出为 undefined）。
 */
export type ProxyTtsRequest =
  | { readonly kind: "none" }
  | { readonly kind: "invalid" }
  | { readonly kind: "tts"; readonly text: string; readonly tone: string | undefined };
