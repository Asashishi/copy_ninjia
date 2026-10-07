/**
 * 模型返回的 base64 二进制载荷的公共解码契约，生图与语音合成共用。
 *
 * 两条链路的门禁各自独立（生图核对 PNG/JPEG 字节签名，语音合成由
 * aiChat/ai/voiceEncoding.ts 按 MIME 判定容器）；「规范性 + 大小上限 + 解码一次」
 * 与载荷类型无关，由本契约承担。失败原因为公共原因加各自的领域专属原因。
 */

/** base64 解码闸的公共失败原因；只用于错误日志定位（英文，见 AGENTS.md 日志约定）。 */
export type Base64PayloadDecodeFailure =
  | "empty payload"
  | "encoded payload exceeds the size limit"
  | "payload is not canonical base64"
  | "decoded payload is empty or exceeds the size limit";

/** 解码闸的中间结果；调用方据此再跑自己的 MIME/签名门禁。 */
export type Base64PayloadDecodeResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: Base64PayloadDecodeFailure };
