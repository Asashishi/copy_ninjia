/**
 * Gemini 回复的共用显式缓存 scope（text）：只装「系统提示词 + 工具声明 + toolConfig」，
 * 全群共用；参考记忆、转录与运行时状态不进缓存。回复会话只在第 1 轮引用它，第 2 轮起
 * 回到完整请求，由隐式前缀缓存接住工具往返（见 replySession.ts）。
 *
 * 按系统提示词分槽：默认人设一槽，设了自定义人设的群各一槽，至多
 * GEMINI_TEXT_CACHE_MAX_SLOTS 槽。扫描、创建、续期、释放与淘汰都在
 * infra/geminiContextCache.ts 的共用核心里；本 scope 的登记表归 AI 闲聊 Worker，后台请求
 * 沿用该 Worker 的 abort 信号，创建的输入 token 以 text 能力上报。
 */

import {
  GEMINI_TEXT_CACHE_DISPLAY_NAME_PREFIX,
  GEMINI_TEXT_CACHE_ERROR_LABEL,
  GEMINI_TEXT_CACHE_MAX_SLOTS,
} from "../../consts/aiChat/gemini";
import { textGeminiContextCache } from "../../cache/workers/aiChat/geminiContextCache";
import { aiChatWorkerAbortController } from "../../cache/workers/aiChat/worker";
import { createGeminiContextCacheRegistry } from "../../infra/geminiContextCache";
import { getGeminiClient } from "./client";
import type { GeminiContextCacheRegistry, GeminiContextCacheScope } from "../../types/geminiContextCache";

/** 回复共用显式缓存的 scope；登记表按当下 text 客户端惰性新建。 */
export const TEXT_GEMINI_CONTEXT_CACHE_SCOPE: Readonly<GeminiContextCacheScope> = {
  registry(): GeminiContextCacheRegistry {
    textGeminiContextCache.current ??= createGeminiContextCacheRegistry(getGeminiClient("text"));
    return textGeminiContextCache.current;
  },
  signal(): AbortSignal {
    return aiChatWorkerAbortController.current.signal;
  },
  displayNamePrefix: GEMINI_TEXT_CACHE_DISPLAY_NAME_PREFIX,
  maxSlots: GEMINI_TEXT_CACHE_MAX_SLOTS,
  capability: "text",
  errorLabel: GEMINI_TEXT_CACHE_ERROR_LABEL,
};
