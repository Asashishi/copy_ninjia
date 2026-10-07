/**
 * 模型返回的 base64 载荷的公共解码闸：规范性校验、编码与解码两道大小上限、解码一次。
 *
 * 生图（imagePayload.ts）与语音合成（speechPayload.ts）共用这一段，各自只保留自己的
 * MIME/签名门禁。上限由调用方按各自领域常量传入，本模块不认识任何一种载荷。
 *
 * 纯函数叶子模块，不接触任何缓存与 SDK 类型（见 AGENTS.md 的「缓存与线程归属」）。
 */

import type {
  Base64PayloadDecodeResult,
} from "../../../types/aiChat/payload";
import { BASE64_NON_ALPHABET_PATTERN } from "../../../consts/aiChat/payload";

/**
 * 标准 base64（无换行）的规范性校验：长度为 4 的倍数，仅在末尾出现 `=` 填充。
 * 模块内部使用，由 decodeBase64Payload 调用。
 */
function isCanonicalBase64(encoded: string): boolean {
  if (encoded.length === 0 || encoded.length % 4 !== 0) return false;
  const padding: number = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const firstNonAlphabet: number = encoded.search(BASE64_NON_ALPHABET_PATTERN);
  return firstNonAlphabet === (padding === 0 ? -1 : encoded.length - padding);
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
 * 先按编码态字符数上限拦截，再校验规范性，最后解码一次并核对字节数上限；
 * 调用方的签名判定复用同一份字节。
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
