/**
 * 生图结果载荷的校验与解码，两家供应商共用。Gemini 的 inlineData 与 OpenAI
 * 的 b64_json 都是「模型给一串 base64」，把校验放在唯一入口才能保证换供应商
 * 不会绕过大小上限与文件签名核对。
 *
 * 纯函数叶子模块，不接触任何缓存与 SDK 类型（见 AGENTS.md 的「缓存与线程归属」）。
 */

import {
  IMAGE_GENERATION_MAX_BYTES,
  IMAGE_GENERATION_MAX_ENCODED_CHARS,
  PNG_SIGNATURE,
} from "../../../consts/aiChat/imageGeneration";
import type {
  GeneratedChatImage,
  GeneratedImageDecodeFailure,
  GeneratedImageDecodeResult,
} from "../../../types/aiChat/imageGeneration";

/** decodeCheckedBytes 的中间结果；失败原因一路带到调用方的日志。 */
type CheckedBytes =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: GeneratedImageDecodeFailure };

/** API 约定返回无换行的标准 base64；严格校验后才交给 Bun 原生解码器。 */
export function isCanonicalBase64(encoded: string): boolean {
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

/** 字节流的起始签名是否与声明的 MIME 一致；防止拿到挂着图片 MIME 的其它载荷。 */
function hasExpectedImageSignature(bytes: Uint8Array, mimeType: GeneratedChatImage["mimeType"]): boolean {
  if (mimeType === "image/png") {
    return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((value: number, index: number): boolean => bytes[index] === value);
  }
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * base64 规范性与大小上限的统一门禁，通过后解码一次。
 *
 * 先按 base64 理论上限挡住异常大响应，避免解码后才发现超限而额外分配一份
 * 最多不可控大小的字节数组；解码只发生一次，签名判定复用同一份字节。
 */
function decodeCheckedBytes(encoded: string): CheckedBytes {
  if (typeof encoded !== "string" || encoded.length === 0) return { ok: false, reason: "empty payload" };
  if (encoded.length > IMAGE_GENERATION_MAX_ENCODED_CHARS) {
    return { ok: false, reason: "encoded payload exceeds the size limit" };
  }
  if (!isCanonicalBase64(encoded)) return { ok: false, reason: "payload is not canonical base64" };
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
  if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_GENERATION_MAX_BYTES) {
    return { ok: false, reason: "decoded payload is empty or exceeds the size limit" };
  }
  return { ok: true, bytes };
}

/**
 * 把一段模型返回的 base64 收窄成可发送的图片；任一道校验不过返回 null。
 * @param encoded 标准 base64（无换行）。
 * @param mimeType 供应商声明的 MIME；只接受 png 与 jpeg，且必须与字节签名一致。
 */
export function decodeGeneratedImage(encoded: string, mimeType: string | undefined): GeneratedChatImage | null {
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") return null;
  const checked: CheckedBytes = decodeCheckedBytes(encoded);
  // Gemini 侧逐 part 扫描，一个 part 不合格就换下一个，因此这里只需要「行不行」
  // ——真正无图时的诊断由 aiChat/gemini/image.ts 按 candidate 的收尾原因给出。
  if (!checked.ok || !hasExpectedImageSignature(checked.bytes, mimeType)) return null;
  return { bytes: checked.bytes, mimeType };
}

/**
 * 同上，但 MIME 由字节签名自己认。供不随载荷声明 MIME 的接口使用（OpenAI 的
 * images 接口只回一串 b64_json，格式由请求参数与模型共同决定，响应里没有
 * 权威的 MIME 字段）——签名认不出 png/jpeg 就当作不可用，不做猜测性放行。
 *
 * 失败带回原因而不是裸 null：这条路没有第二个候选可试，调用方需要区分格式不
 * 匹配与大小超限。记日志留给调用方，本模块保持纯函数叶子（见文件头注）。
 */
export function decodeGeneratedImageBySignature(encoded: string): GeneratedImageDecodeResult {
  const checked: CheckedBytes = decodeCheckedBytes(encoded);
  if (!checked.ok) return checked;
  if (hasExpectedImageSignature(checked.bytes, "image/png")) {
    return { ok: true, image: { bytes: checked.bytes, mimeType: "image/png" } };
  }
  if (hasExpectedImageSignature(checked.bytes, "image/jpeg")) {
    return { ok: true, image: { bytes: checked.bytes, mimeType: "image/jpeg" } };
  }
  return { ok: false, reason: "byte signature matches neither PNG nor JPEG" };
}
