/**
 * Gemini 侧的纯文本生成、视觉描述与语音转写。三者共用 client.ts 的
 * requestGeminiTextResult，差别只在请求体：文本走一段 user 文本，视觉多挂一份
 * inlineData 图片字节，语音则挂一份 inlineData 音频字节。
 *
 * 视觉与语音共用 config/agent.json 的 `agent.media`：那一档本来就是多模态理解
 * 模型，图片与音频是它的两种输入模态，不是两个模型。
 *
 * 清洗与截断由调用方通过 normalize 传入——摘要、贴纸整包简介、三类媒体描述与
 * 语音转写的字数上限各不相同，那是领域策略，不该下沉到供应商实现包。
 */

import {
  GEMINI_CHAT_SUMMARY_MAX_TOKENS,
  GEMINI_MEDIA_DESCRIPTION_MAX_TOKENS,
  GEMINI_STICKER_PACK_SUMMARY_MAX_TOKENS,
  GEMINI_SUMMARY_TEMPERATURE,
  GEMINI_VOICE_TRANSCRIPTION_MAX_TOKENS,
} from "../../consts/aiChat/gemini";
import { getAgentDeploymentConfig } from "../../config/agent";
import { requestGeminiTextResult } from "./client";
import type { GenerateContentParameters } from "@google/genai";
import type {
  AiTextRequest,
  AiTextResult,
  AiVisionRequest,
  AiVoiceRequest,
} from "../../types/aiChat/provider";

/** 中性总结档位的一次文本生成（冷消息压缩、贴纸整包简介）。 */
export function generateGeminiText(request: AiTextRequest): Promise<AiTextResult> {
  return requestGeminiTextResult({
    capability: "summary",
    buildBody: (): GenerateContentParameters => ({
      model: getAgentDeploymentConfig().summary.model,
      contents: [{ role: "user", parts: [{ text: request.userContent }] }],
      config: {
        systemInstruction: request.systemPrompt,
        temperature: GEMINI_SUMMARY_TEMPERATURE,
        maxOutputTokens: request.purpose === "chatSummary"
          ? GEMINI_CHAT_SUMMARY_MAX_TOKENS
          : GEMINI_STICKER_PACK_SUMMARY_MAX_TOKENS,
      },
    }),
    errorLabel: request.errorLabel,
    normalize: request.normalize,
  });
}

/**
 * 一次视觉描述。图片以 inlineData 直接内联进请求（字节已由
 * aiChat/ai/telegramImage.ts 下载并转码成 jpg/png），描述指令跟在图片之后
 * ——先图后文是 Gemini 视觉输入的惯用顺序。
 */
export function describeGeminiVision(request: AiVisionRequest): Promise<AiTextResult> {
  return requestGeminiTextResult({
    capability: "media",
    buildBody: (): GenerateContentParameters => ({
      model: getAgentDeploymentConfig().media.model,
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
    errorLabel: request.errorLabel,
    normalize: request.normalize,
  });
}

/**
 * 一次语音转写。音频以 inlineData 直接内联进请求（字节由
 * aiChat/ai/telegramAudio.ts 按原容器取回，不转码），转写指令跟在音频之后
 * ——先媒体后文，与上面的视觉描述同一惯用顺序。
 *
 * 不传 temperature：转写要的是忠实还原，采样随机性只会让模型开始「润色」群友的
 * 原话，而这条会整行进转录被当成真人说过的话。用模型默认档即可，这里刻意不引入
 * 一个需要单独调参的旋钮。
 */
export function transcribeGeminiVoice(request: AiVoiceRequest): Promise<AiTextResult> {
  return requestGeminiTextResult({
    capability: "media",
    buildBody: (): GenerateContentParameters => ({
      model: getAgentDeploymentConfig().media.model,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: request.clip.mime, data: request.clip.bytes.toString("base64") } },
            { text: request.prompt },
          ],
        },
      ],
      config: { maxOutputTokens: GEMINI_VOICE_TRANSCRIPTION_MAX_TOKENS },
    }),
    errorLabel: request.errorLabel,
    normalize: request.normalize,
  });
}
