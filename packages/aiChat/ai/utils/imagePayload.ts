/**
 * 生图结果载荷的校验与解码，Gemini 的 inlineData 与 OpenAI 的 b64_json 共用这一入口：
 * 大小上限与文件签名核对都在这里完成。
 *
 * 规范性与大小上限那一段与载荷类型无关，收在 ./base64Payload.ts 与语音合成共用；
 * 本文件只保留生图独有的字节签名门禁。
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
  GeneratedImageDecodeResult,
} from "../../../types/aiChat/imageGeneration";
import type { Base64PayloadDecodeResult } from "../../../types/aiChat/payload";
import { decodeBase64Payload } from "./base64Payload";

/** 字节流的起始签名是否与声明的 MIME 一致。 */
function hasExpectedImageSignature(bytes: Uint8Array, mimeType: GeneratedChatImage["mimeType"]): boolean {
  if (mimeType === "image/png") {
    return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((value: number, index: number): boolean => bytes[index] === value);
  }
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** 按生图的两道上限跑公共解码闸。 */
function decodeCheckedBytes(encoded: string): Base64PayloadDecodeResult {
  return decodeBase64Payload({
    encoded,
    maxEncodedChars: IMAGE_GENERATION_MAX_ENCODED_CHARS,
    maxBytes: IMAGE_GENERATION_MAX_BYTES,
  });
}

/**
 * 把一段模型返回的 base64 收窄成可发送的图片；任一道校验不过返回 null。
 * @param encoded 标准 base64（无换行）。
 * @param mimeType 供应商声明的 MIME；只接受 png 与 jpeg，且必须与字节签名一致。
 */
export function decodeGeneratedImage(encoded: string, mimeType: string | undefined): GeneratedChatImage | null {
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") return null;
  const checked: Base64PayloadDecodeResult = decodeCheckedBytes(encoded);
  // 返回 null 表示这一份不可用；真正无图时的诊断由 aiChat/gemini/image.ts 按 candidate 的收尾原因给出。
  if (!checked.ok || !hasExpectedImageSignature(checked.bytes, mimeType)) return null;
  return { bytes: checked.bytes, mimeType };
}

/**
 * 同上，但 MIME 由字节签名判定，供响应里不带 MIME 的接口使用（OpenAI 的 images 接口
 * 只回 b64_json）；签名认不出 png/jpeg 就判不可用。
 *
 * 失败带回原因（ok: false 的 reason）。记日志留给调用方，本模块保持纯函数叶子（见文件头注）。
 */
export function decodeGeneratedImageBySignature(encoded: string): GeneratedImageDecodeResult {
  const checked: Base64PayloadDecodeResult = decodeCheckedBytes(encoded);
  if (!checked.ok) return checked;
  if (hasExpectedImageSignature(checked.bytes, "image/png")) {
    return { ok: true, image: { bytes: checked.bytes, mimeType: "image/png" } };
  }
  if (hasExpectedImageSignature(checked.bytes, "image/jpeg")) {
    return { ok: true, image: { bytes: checked.bytes, mimeType: "image/jpeg" } };
  }
  return { ok: false, reason: "byte signature matches neither PNG nor JPEG" };
}
