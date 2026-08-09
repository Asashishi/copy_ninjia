import type { GoogleGenAI } from "@google/genai";
import type { AgentCapability } from "../../../types/config";

/**
 * Google GenAI 底层客户端的线程内缓存。aiChat/gemini/client.ts 按能力首次请求
 * 时填充；每项能力独立持有 api_key 与 base_url，容量固定最多五个条目。进程退出时
 * 随 isolate 释放，Worker 崩溃重建后从空 holder 按配置重建。
 *
 * 归属 AI 闲聊 Worker：Gemini 的全部调用方（回复生成、视觉描述、贴纸整包
 * 简介、生图）都在那条线程上，主线程侧只经消息协议要结果，不碰客户端。
 *
 * 与 cache/workers/aiChat/openai.ts **可以同时非空**，理由见那一份的说明：
 * 供应商按能力分别选，闲聊与生图可以分属两家。
 */
export const geminiClientCache: { current: Map<AgentCapability, GoogleGenAI> | null } = { current: null };
