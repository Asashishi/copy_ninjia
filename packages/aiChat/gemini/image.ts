/**
 * Gemini 侧的生图：调独立图片模型生成一张 1K 图片，文本段与思考中间图一律忽略。
 * 载荷校验（base64 规范性、大小上限、文件签名）走两家共用的
 * aiChat/ai/utils/imagePayload.ts，换供应商不会绕过任何一道门禁。
 */

import { FinishReason } from "@google/genai";
import type { Blob as GenAiBlob, Candidate, GenerateContentParameters, GenerateContentResponse, Part } from "@google/genai";
import {
  GEMINI_IMAGE_ERROR_LABEL,
  GEMINI_IMAGE_SIZE,
} from "../../consts/aiChat/gemini";
import { getAgentDeploymentConfig } from "../../config/agent";
import { decodeGeneratedImage } from "../ai/utils/imagePayload";
import { requestGeminiResponse } from "./client";
import type { AiImageRequest } from "../../types/aiChat/provider";
import type { GeneratedChatImage } from "../../types/aiChat/imageGeneration";

function extractGeneratedImage(data: GenerateContentResponse): GeneratedChatImage | null {
  const candidate: Candidate | undefined = data.candidates?.[0];
  // unary generateContent 返回时生成已经结束；只有明确 STOP 的 candidate
  // 才可发送。安全/复刻/禁止内容/NO_IMAGE 等异常即使意外夹带 payload 也拒绝。
  if (candidate?.finishReason !== FinishReason.STOP) return null;
  const parts: Part[] = candidate.content?.parts ?? [];
  for (const part of parts) {
    if (part.thought === true || !part.inlineData) continue;
    const { data: encoded, mimeType }: GenAiBlob = part.inlineData;
    if (typeof encoded !== "string") continue;
    const image: GeneratedChatImage | null = decodeGeneratedImage(encoded, mimeType);
    if (image) return image;
  }
  return null;
}

/** 调 Gemini 生图模型生成一张 1K 图片；无可用载荷时返回 null。 */
export async function generateGeminiImage({
  prompt,
  aspectRatio,
  referenceImage,
  signal,
}: AiImageRequest): Promise<GeneratedChatImage | null> {
  const contents: GenerateContentParameters["contents"] = referenceImage
    ? [{
      role: "user",
      parts: [
        { text: prompt },
        { inlineData: { mimeType: referenceImage.mime, data: referenceImage.bytes.toBase64() } },
      ],
    }]
    : prompt;
  const response: GenerateContentResponse | null = await requestGeminiResponse(
    "image",
    (): GenerateContentParameters => {
      const model: string | undefined = getAgentDeploymentConfig().image?.model;
      if (model === undefined) throw new Error('Agent capability "image" is not configured.');
      return {
        model,
        contents,
        config: {
          abortSignal: signal,
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: { aspectRatio, imageSize: GEMINI_IMAGE_SIZE },
        },
      };
    },
    GEMINI_IMAGE_ERROR_LABEL
  );
  return response ? extractGeneratedImage(response) : null;
}
