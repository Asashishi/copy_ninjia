/**
 * Google GenAI 协议的广告检测传输层；业务提示词与 JSON 收窄仍归 classifier。
 *
 * **请求结构**：系统指令只放「判定规则 + 部署示例」（params.instructions）；contents 固定为
 * 一个 user 轮、两个 part——系统事实一行在前、待判定消息串在后。系统指令可用时经
 * ad_detect 的显式缓存 scope（下方 AD_DETECT_GEMINI_CONTEXT_CACHE_SCOPE，核心在
 * infra/geminiContextCache.ts）改为引用 cachedContent，此时请求不带 systemInstruction，
 * contents 不变——有无缓存，模型看到的内容逐字一致。引用缓存的请求被端点以 408/429 以外
 * 的 4xx 拒绝时释放登记，当场按带系统指令的完整请求补发一次。
 */

import { ApiError, FinishReason, GoogleGenAI } from "@google/genai";
import type { Candidate, GenerateContentResponse } from "@google/genai";
import { adDetectGoogleClientHolder } from "../../../../cache/workers/antiRaid/google";
import { antiRaidDispatchSignal } from "../../../../cache/workers/antiRaid/tasks";
import {
  adDetectGeminiCacheContent,
  adDetectGeminiContextCache,
} from "../../../../cache/workers/antiRaid/geminiContextCache";
import { getAdDetectAgentConfig } from "../../../../config/agent";
import {
  AD_DETECT_GEMINI_CACHE_DISPLAY_NAME_PREFIX,
  AD_DETECT_GEMINI_CACHE_ERROR_LABEL,
  AD_DETECT_GEMINI_CACHE_MAX_SLOTS,
  AD_DETECT_GOOGLE_REQUEST_ATTEMPTS,
  AD_DETECT_GOOGLE_REQUEST_TIMEOUT_MS,
  AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS,
} from "../../../../consts/antiRaid/adDetect";
import { logger } from "../../../../infra/logger";
import { reportGeminiUsage } from "../../../../infra/aiCacheUsage";
import {
  acquireGeminiContextCache,
  createGeminiContextCacheRegistry,
  geminiContextCacheContent,
  isGeminiContextCacheRejection,
  releaseGeminiContextCache,
} from "../../../../infra/geminiContextCache";
import type { AdDetectAgentConfig } from "../../../../types/config";
import type { AdDetectJsonRequestParams } from "../../../../types/antiRaid/adDetect";
import type {
  GeminiContextCacheContent,
  GeminiContextCacheRegistry,
  GeminiContextCacheScope,
} from "../../../../types/geminiContextCache";

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
      headers: config.headers,
      timeout: AD_DETECT_GOOGLE_REQUEST_TIMEOUT_MS,
      retryOptions: { attempts: AD_DETECT_GOOGLE_REQUEST_ATTEMPTS },
    },
  });
  return adDetectGoogleClientHolder.current;
}

/**
 * ad_detect 的显式缓存 scope：缓存内容只有「判定规则 + 部署示例」，登记表按当下
 * ad_detect 客户端惰性新建；后台请求使用 Anti-Raid Worker 的尽力而为派发信号，停机后
 * 随之取消；创建的输入 token 以 ad_detect 能力上报。
 */
export const AD_DETECT_GEMINI_CONTEXT_CACHE_SCOPE: Readonly<GeminiContextCacheScope> = {
  registry(): GeminiContextCacheRegistry {
    adDetectGeminiContextCache.current ??= createGeminiContextCacheRegistry(getAdDetectGoogleClient());
    return adDetectGeminiContextCache.current;
  },
  signal: antiRaidDispatchSignal,
  displayNamePrefix: AD_DETECT_GEMINI_CACHE_DISPLAY_NAME_PREFIX,
  maxSlots: AD_DETECT_GEMINI_CACHE_MAX_SLOTS,
  capability: "ad_detect",
  errorLabel: AD_DETECT_GEMINI_CACHE_ERROR_LABEL,
};

/** 本次要缓存的内容；模型与系统指令都没变时直接复用已算好的指纹。 */
function cacheContentOf(model: string, instructions: string): GeminiContextCacheContent {
  const cached: GeminiContextCacheContent | null = adDetectGeminiCacheContent.current;
  if (cached !== null && cached.model === model && cached.systemInstruction === instructions) return cached;
  const content: GeminiContextCacheContent = geminiContextCacheContent({ model, systemInstruction: instructions });
  adDetectGeminiCacheContent.current = content;
  return content;
}

/** 发一次 generateContent；cachedContent 非空时引用显式缓存、不带系统指令。 */
function generateAdDetectContent(
  { model, instructions, fact, userContent, maxOutputTokens }: AdDetectJsonRequestParams,
  cachedContent: string | null
): Promise<GenerateContentResponse> {
  return getAdDetectGoogleClient().models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: fact }, { text: userContent }] }],
    config: {
      cachedContent: cachedContent ?? undefined,
      systemInstruction: cachedContent === null ? instructions : undefined,
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
}

function logGoogleFailure(errorLabel: string, error: unknown): void {
  if (error instanceof ApiError) {
    logger.error(`${errorLabel} failed: ${error.status} ${error.message}`);
  } else {
    logger.error(`Error calling ${errorLabel}:`, error);
  }
}

/** 发一次结构化 JSON 请求；undefined 表示请求失败，null 表示成功但正文不可用。 */
async function attemptGoogleJson(params: AdDetectJsonRequestParams): Promise<string | null | undefined> {
  let cachedContent: string | null = null;
  let response: GenerateContentResponse;
  try {
    cachedContent = acquireGeminiContextCache(
      AD_DETECT_GEMINI_CONTEXT_CACHE_SCOPE,
      cacheContentOf(params.model, params.instructions)
    );
    response = await generateAdDetectContent(params, cachedContent);
  } catch (error: unknown) {
    logGoogleFailure(params.errorLabel, error);
    if (cachedContent === null || !isGeminiContextCacheRejection(error)) return undefined;
    releaseGeminiContextCache(AD_DETECT_GEMINI_CONTEXT_CACHE_SCOPE, cachedContent);
    try {
      response = await generateAdDetectContent(params, null);
    } catch (retryError: unknown) {
      logGoogleFailure(params.errorLabel, retryError);
      return undefined;
    }
  }
  reportGeminiUsage({ capability: "ad_detect", model: params.model, usage: response.usageMetadata });
  const candidate: Candidate | undefined = response.candidates?.[0];
  if (candidate?.finishReason !== FinishReason.STOP) return null;
  const body: string = response.text?.trim() ?? "";
  return body.length === 0 ? null : body;
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
