/**
 * 模型返回的 base64 载荷的公共解码闸：规范性校验、编码与解码两道大小上限、解码一次。
 *
 * 生图（imagePayload.ts）与生歌（songPayload.ts）共用这一段，各自只保留自己的
 * MIME/签名门禁。上限由调用方按各自领域常量传入，本模块不认识任何一种载荷。
 *
 * 纯函数叶子模块，不接触任何缓存与 SDK 类型（见 AGENTS.md 的「缓存与线程归属」）。
 */

import type {
  Base64PayloadDecodeResult,
} from "../../../types/aiChat/payload";

/**
 * API 约定返回无换行的标准 base64；严格校验后才交给 Bun 原生解码器。
 *
 * 不导出：唯一消费方就是下面的 decodeBase64Payload，而它已经是两条链路共用的
 * 单一入口。单独放出去只会多一个可以绕过大小上限直接用的口子。
 */
function isCanonicalBase64(encoded: string): boolean {
  if (encoded.length === 0 || encoded.length % 4 !== 0) return false;
  const padding: number = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  for (let i: number = 0; i < encoded.length - padding; i++) {
    const code: number = encoded.charCodeAt(i);
    const valid: boolean =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f;
    if (!valid) return false;
  }
  for (let i: number = encoded.length - padding; i < encoded.length; i++) {
    if (encoded.charCodeAt(i) !== 0x3d) return false;
  }
  return true;
}

export interface DecodeBase64PayloadOptions {
  /** 供应商返回的标准 base64（无换行）。 */
  readonly encoded: string;
  /** 编码态字符数上限，按领域的字节上限换算。 */
  readonly maxEncodedChars: number;
  /** 解码后的字节数上限。 */
  readonly maxBytes: number;
}

/**
 * base64 规范性与大小上限的统一门禁，通过后解码一次。
 *
 * 先按 base64 理论上限挡住异常大响应，避免解码后才发现超限而额外分配一份
 * 最多不可控大小的字节数组；解码只发生一次，调用方的签名判定复用同一份字节。
 */
export function decodeBase64Payload({
  encoded,
  maxEncodedChars,
  maxBytes,
}: DecodeBase64PayloadOptions): Base64PayloadDecodeResult {
  if (typeof encoded !== "string" || encoded.length === 0) {
    return { ok: false, reason: "empty payload" };
  }
  if (encoded.length > maxEncodedChars) {
    return { ok: false, reason: "encoded payload exceeds the size limit" };
  }
  if (!isCanonicalBase64(encoded)) {
    return { ok: false, reason: "payload is not canonical base64" };
  }
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.fromBase64(encoded, {
      alphabet: "base64",
      lastChunkHandling: "strict",
    });
  } catch (error: unknown) {
    void error;
    return { ok: false, reason: "payload is not canonical base64" };
  }
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    return { ok: false, reason: "decoded payload is empty or exceeds the size limit" };
  }
  return { ok: true, bytes };
}
