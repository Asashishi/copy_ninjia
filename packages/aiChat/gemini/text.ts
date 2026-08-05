/**
 * Gemini 侧的纯文本生成与视觉描述。两者共用 client.ts 的
 * requestGeminiTextResult，差别只在请求体：文本走一段 user 文本，视觉多挂一份
 * inlineData 图片字节。
 *
 * 清洗与截断由调用方通过 normalize 传入——摘要、贴纸整包简介、三类媒体描述
 * 的字数上限各不相同，那是领域策略，不该下沉到供应商实现包。
 */

import {
  GEMINI_CHAT_SUMMARY_MAX_TOKENS,
  GEMINI_MEDIA_DESCRIPTION_MAX_TOKENS,
  GEMINI_STICKER_PACK_SUMMARY_MAX_TOKENS,
  GEMINI_SUMMARY_TEMPERATURE,
} from "../../consts/aiChat/gemini";
import { getGeminiDeploymentConfig } from "../../config/gemini";
import { requestGeminiTextResult } from "./client";
import type { GenerateContentParameters } from "@google/genai";
import type { AiTextRequest, AiTextResult, AiVisionRequest } from "../../types/aiChat/provider";

/** 中性总结档位的一次文本生成（冷消息压缩、贴纸整包简介）。 */
export function generateGeminiText(request: AiTextRequest): Promise<AiTextResult> {
  return requestGeminiTextResult(
    (): GenerateContentParameters => ({
      model: getGeminiDeploymentConfig().models.summary,
      contents: [{ role: "user", parts: [{ text: request.userContent }] }],
      config: {
        systemInstruction: request.systemPrompt,
        temperature: GEMINI_SUMMARY_TEMPERATURE,
        maxOutputTokens: request.purpose === "chatSummary"
          ? GEMINI_CHAT_SUMMARY_MAX_TOKENS
          : GEMINI_STICKER_PACK_SUMMARY_MAX_TOKENS,
      },
    }),
    request.errorLabel,
    request.normalize
  );
}

/**
 * 一次视觉描述。图片以 inlineData 直接内联进请求（字节已由
 * aiChat/ai/telegramImage.ts 下载并转码成 jpg/png），描述指令跟在图片之后
 * ——先图后文是 Gemini 视觉输入的惯用顺序。
 */
export function describeGeminiVision(request: AiVisionRequest): Promise<AiTextResult> {
  return requestGeminiTextResult(
    (): GenerateContentParameters => ({
      model: getGeminiDeploymentConfig().models.media,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: request.image.mime, data: request.image.bytes.toString("base64") } },
            { text: request.prompt },
          ],
        },
      ],
      config: { maxOutputTokens: GEMINI_MEDIA_DESCRIPTION_MAX_TOKENS },
    }),
    request.errorLabel,
    request.normalize
  );
}
