import { FinishReason, type Blob as GenAiBlob, type Candidate, type GenerateContentParameters, type GenerateContentResponse, type Part } from "@google/genai";
import {
  DEFAULT_IMAGE_GENERATION_ASPECT_RATIO,
  GEMINI_IMAGE_GENERATION_MODEL,
  IMAGE_GENERATION_ASPECT_RATIOS,
  IMAGE_GENERATION_MAX_ENCODED_CHARS,
  IMAGE_GENERATION_MAX_BYTES,
  PNG_SIGNATURE,
  type ImageGenerationAspectRatio,
} from "../consts/aiChat/imageGeneration";
import { requestGeminiResponse } from "./gemini";
import type { VisionImage } from "../libs/image";

export interface GeneratedChatImage {
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png";
}

function ratioValue(ratio: ImageGenerationAspectRatio): number {
  const [width, height]: number[] = ratio.split(":").map(Number);
  return width! / height!;
}

/** API 约定返回无换行的标准 base64；严格校验，避免 Buffer.from 静默忽略脏字符。 */
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

function hasExpectedImageSignature(bytes: Uint8Array, mimeType: GeneratedChatImage["mimeType"]): boolean {
  if (mimeType === "image/png") {
    return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((value: number, index: number): boolean => bytes[index] === value);
  }
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * 官方比例原样保留；其它正数比例按 log(width / height) 的距离取最近项，
 * 这样横竖互换时距离仍对称。支持 W:H、W/H、WxH 与 W×H 写法。
 */
export function normalizeImageAspectRatio(requested: string | undefined): ImageGenerationAspectRatio | null {
  if (requested === undefined || requested.trim() === "") return DEFAULT_IMAGE_GENERATION_ASPECT_RATIO;
  const match: RegExpExecArray | null = /^(\d+(?:\.\d+)?)\s*(?::|\/|x|×)\s*(\d+(?:\.\d+)?)$/i.exec(requested.trim());
  if (!match) return null;
  const width: number = Number(match[1]);
  const height: number = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;

  const target: number = width / height;
  let closest: ImageGenerationAspectRatio = DEFAULT_IMAGE_GENERATION_ASPECT_RATIO;
  let closestDistance: number = Number.POSITIVE_INFINITY;
  for (const candidate of IMAGE_GENERATION_ASPECT_RATIOS) {
    const distance: number = Math.abs(Math.log(target / ratioValue(candidate)));
    if (distance < closestDistance) {
      closest = candidate;
      closestDistance = distance;
    }
  }
  return closest;
}

function extractGeneratedImage(data: GenerateContentResponse): GeneratedChatImage | null {
  const candidate: Candidate | undefined = data.candidates?.[0];
  // unary generateContent 返回时生成已经结束；只有明确 STOP 的 candidate
  // 才可发送。安全/复刻/禁止内容/NO_IMAGE 等异常即使意外夹带 payload 也拒绝。
  if (candidate?.finishReason !== FinishReason.STOP) return null;
  const parts: Part[] = candidate.content?.parts ?? [];
  for (const part of parts) {
    if (part.thought === true || !part.inlineData) continue;
    const { data: encoded, mimeType }: GenAiBlob = part.inlineData;
    if (typeof encoded !== "string" || !encoded) continue;
    if (mimeType !== "image/png" && mimeType !== "image/jpeg") continue;
    // 先按 base64 理论上限挡住异常大响应，避免解码后才发现超限而额外分配
    // 一份最多不可控大小的 Buffer。API 返回的标准 base64 不含换行。
    if (encoded.length > IMAGE_GENERATION_MAX_ENCODED_CHARS) continue;
    if (!isCanonicalBase64(encoded)) continue;
    const bytes: Buffer = Buffer.from(encoded, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_GENERATION_MAX_BYTES) continue;
    if (!hasExpectedImageSignature(bytes, mimeType)) continue;
    return { bytes, mimeType };
  }
  return null;
}

export interface GenerateChatImageParams {
  prompt: string;
  aspectRatio: ImageGenerationAspectRatio;
  referenceImage?: VisionImage;
  signal?: AbortSignal;
}

/** 调用独立图片模型生成一张 1K 图片；文本段与思考中间图一律忽略。 */
export async function generateChatImage({
  prompt,
  aspectRatio,
  referenceImage,
  signal,
}: GenerateChatImageParams): Promise<GeneratedChatImage | null> {
  const contents: GenerateContentParameters["contents"] = referenceImage
    ? [{
      role: "user",
      parts: [
        { text: prompt },
        { inlineData: { mimeType: referenceImage.mime, data: referenceImage.bytes.toString("base64") } },
      ],
    }]
    : prompt;
  const response: GenerateContentResponse | null = await requestGeminiResponse(
    {
      model: GEMINI_IMAGE_GENERATION_MODEL,
      contents,
      config: {
        abortSignal: signal,
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio, imageSize: "1K" },
      },
    },
    "Gemini image generation API"
  );
  return response ? extractGeneratedImage(response) : null;
}
