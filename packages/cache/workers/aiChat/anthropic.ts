/** owner: workers/aiChat。 */

import type Anthropic from "@anthropic-ai/sdk";
import type { AgentCapability } from "../../../types/config";

/**
 * Anthropic 底层客户端的线程内缓存。aiChat/anthropic/client.ts 按能力首次请求时填充；每项能力
 * 独立持有 api_key 与 base_url，每项能力至多一个条目（image 与 tts 不会选
 * anthropic）。agent.json 热重载时由 aiChat/provider.ts 的 reloadAgentDeploymentConfig 整体清空，
 * 下一次请求按新配置重建；进程退出时随 isolate 释放，Worker 崩溃重建后从空 holder 重建。
 *
 * 归属 AI 闲聊 Worker：Anthropic 的全部调用方都在那条线程上。与
 * cache/workers/aiChat/{gemini,openai}.ts 可同时非空：供应商按能力分别选。
 */
export const anthropicClientCache: { current: Map<AgentCapability, Anthropic> | null } = { current: null };
