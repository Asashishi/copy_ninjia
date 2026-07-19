import type { GenerateContentResponse, Part } from "@google/genai";
import {
  DEFAULT_IMAGE_GENERATION_ASPECT_RATIO,
  GEMINI_IMAGE_GENERATION_MODEL,
  IMAGE_GENERATION_ASPECT_RATIOS,
  IMAGE_GENERATION_MAX_BYTES,
  type ImageGenerationAspectRatio,
} from "../consts/aiChat/imageGeneration";
import { requestGeminiResponse } from "./gemini";

export interface GeneratedChatImage {
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png";
}

const MAX_ENCODED_IMAGE_CHARS: number = Math.ceil(IMAGE_GENERATION_MAX_BYTES / 3) * 4;

function ratioValue(ratio: ImageGenerationAspectRatio): number {
  const [width, height] = ratio.split(":").map(Number);
  return width! / height!;
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
  const parts: Part[] = data.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    if (part.thought === true || !part.inlineData) continue;
    const { data: encoded, mimeType } = part.inlineData;
    if (typeof encoded !== "string" || !encoded) continue;
    if (mimeType !== "image/png" && mimeType !== "image/jpeg") continue;
    // 先按 base64 理论上限挡住异常大响应，避免解码后才发现超限而额外分配
    // 一份最多不可控大小的 Buffer。API 返回的标准 base64 不含换行。
    if (encoded.length > MAX_ENCODED_IMAGE_CHARS) continue;
    const bytes: Buffer = Buffer.from(encoded, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_GENERATION_MAX_BYTES) continue;
    return { bytes, mimeType };
  }
  return null;
}

/** 调用独立图片模型生成一张 1K 图片；文本段与思考中间图一律忽略。 */
export async function generateChatImage(
  prompt: string,
  aspectRatio: ImageGenerationAspectRatio
): Promise<GeneratedChatImage | null> {
  const response: GenerateContentResponse | null = await requestGeminiResponse(
    {
      model: GEMINI_IMAGE_GENERATION_MODEL,
      contents: prompt,
      config: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio, imageSize: "1K" },
      },
    },
    "Gemini image generation API"
  );
  return response ? extractGeneratedImage(response) : null;
}
