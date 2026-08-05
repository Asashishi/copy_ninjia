/**
 * AI 闲聊凭据口径的唯一定义。只读 env、不碰运行时状态，也不 import 任何
 * 供应商实现包——命令层、启动 preflight 与 Worker 启动判定都只想问一句
 * 「配没配」，不该为此把 stateStore 或两家 SDK 拉进各自的模块图。
 *
 * 单独成文件而不并进 aiChat/availability.ts：那个模块要读 ChatState，
 * 把它拖进 app/featurePreflight.ts 的依赖里，会让「功能前提自检」反过来
 * 依赖存储层。
 */

import { AI_CHAT_GEMINI_API_KEY, AI_CHAT_OPENAI_API_KEY } from "../infra/config";

/**
 * 进程侧是否握有任一家 AI 供应商的凭据。两把是「或」的关系：默认走 Gemini，
 * 只有它缺席时才降级到 OpenAI（选取见 aiChat/provider.ts）。
 *
 * 口径集中在这里而不是让各调用点自己判两把 key：凭据判定散开之后，新增一家
 * 供应商就要同步改命令、preflight 与 Worker 启动三处，漏一处就是「明明配了
 * 却被拒」。
 */
export function hasAiChatCredentials(): boolean {
  return AI_CHAT_GEMINI_API_KEY !== undefined || AI_CHAT_OPENAI_API_KEY !== undefined;
}

/**
 * 进程侧是否握有 OpenAI 那把凭据。
 *
 * 存在即意味着 config/openai.json 的 ai_agent 段**会被读到**：要么它就是当前
 * 选中的供应商（Gemini 缺席时），要么它只承担生图（`/image_model gpt`）。因此
 * 这一问是 config/readiness.ts 决定要不要探那份文件的唯一依据，不能改问
 * aiChat/provider.ts 的 activeAiProvider()——那个只回答「回复走谁」。
 */
export function hasOpenAiChatCredentials(): boolean {
  return AI_CHAT_OPENAI_API_KEY !== undefined;
}

/** 进程侧是否握有 Gemini 那把凭据；与上面那把成对，服务 `/image_model` 的前置门禁。 */
export function hasGeminiChatCredentials(): boolean {
  return AI_CHAT_GEMINI_API_KEY !== undefined;
}
