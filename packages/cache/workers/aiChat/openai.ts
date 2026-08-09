import type OpenAI from "openai";
import type { AgentCapability } from "../../../types/config";

/**
 * OpenAI 底层客户端的线程内缓存。aiChat/openai/client.ts 按能力首次请求时
 * 填充；每项能力独立持有 api_key 与 base_url，容量固定最多五个条目。
 * 进程退出时随 isolate 释放，Worker 崩溃重建后从空 holder 按配置重建。
 *
 * 归属 AI 闲聊 Worker：AI 闲聊供应商的全部调用方（回复生成、视觉描述、
 * 记忆压缩、贴纸整包简介、生图）都在那条线程上，主线程侧只经消息协议要
 * 结果，不碰客户端。
 *
 * 与 cache/workers/aiChat/gemini.ts 可以同时非空：config/agent.json 按能力分别
 * 选择 provider，因此 summary 走 OpenAI、media 走 Google 时两边都会常驻。
 *
 * 注意与 cache/workers/antiRaid/openai.ts 的区别：那份属于入群守卫线程、
 * 服务广告检测，两条线各用各的客户端与凭据，不共享也不回退。
 */
export const openAiClientCache: { current: Map<AgentCapability, OpenAI> | null } = { current: null };
