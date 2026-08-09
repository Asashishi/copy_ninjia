/** Google GenAI 协议的广告检测传输层；业务提示词与 JSON 收窄仍归 classifier。 */

import { ApiError, FinishReason, GoogleGenAI } from "@google/genai";
import type { Candidate, GenerateContentResponse } from "@google/genai";
import { adDetectGoogleClientHolder } from "../../cache/workers/antiRaid/google";
import { getAdDetectAgentConfig } from "../../config/agent";
import {
  AD_DETECT_GOOGLE_REQUEST_ATTEMPTS,
  AD_DETECT_GOOGLE_REQUEST_TIMEOUT_MS,
  AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS,
} from "../../consts/antiRaid/adDetect";
import { logger } from "../../infra/logger";
import type { AdDetectAgentConfig } from "../../types/config";
import type { AdDetectJsonRequestParams } from "../../types/antiRaid/adDetect";

/** 取得 Anti-Raid Worker 内唯一的 Google 广告检测客户端。 */
function getAdDetectGoogleClient(): GoogleGenAI {
  const config: AdDetectAgentConfig = getAdDetectAgentConfig();
  if (config.provider !== "google") {
    throw new Error('Agent capability "ad_detect" is not configured for the Google provider.');
  }
  adDetectGoogleClientHolder.current ??= new GoogleGenAI({
    apiKey: config.apiKey,
    httpOptions: {
      baseUrl: config.baseUrl,
      timeout: AD_DETECT_GOOGLE_REQUEST_TIMEOUT_MS,
      retryOptions: { attempts: AD_DETECT_GOOGLE_REQUEST_ATTEMPTS },
    },
  });
  return adDetectGoogleClientHolder.current;
}

/** 发一次结构化 JSON 请求；undefined 表示请求失败，null 表示成功但正文不可用。 */
async function attemptGoogleJson({
  model,
  systemPrompt,
  userContent,
  maxOutputTokens,
  errorLabel,
}: AdDetectJsonRequestParams): Promise<string | null | undefined> {
  try {
    const response: GenerateContentResponse = await getAdDetectGoogleClient().models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: userContent }] }],
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens,
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          properties: {
            ad: { type: "boolean" },
            reason: { type: "string" },
          },
          required: ["ad", "reason"],
          additionalProperties: false,
        },
      },
    });
    const candidate: Candidate | undefined = response.candidates?.[0];
    if (candidate?.finishReason !== FinishReason.STOP) return null;
    const body: string = response.text?.trim() ?? "";
    return body.length === 0 ? null : body;
  } catch (error: unknown) {
    if (error instanceof ApiError) {
      logger.error(`${errorLabel} failed: ${error.status} ${error.message}`);
    } else {
      logger.error(`Error calling ${errorLabel}:`, error);
    }
    return undefined;
  }
}

/** 空响应有限重试；请求异常已经由 SDK 按配置重试，不在这里叠加。 */
export async function requestGoogleAdDetectJson(
  params: AdDetectJsonRequestParams
): Promise<string | null> {
  for (let attempt: number = 1; attempt <= AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS; attempt++) {
    const body: string | null | undefined = await attemptGoogleJson(params);
    if (body === undefined) return null;
    if (body !== null) return body;
  }
  logger.error(
    `${params.errorLabel} returned no usable body in ` +
    `${AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS} attempt(s).`
  );
  return null;
}
