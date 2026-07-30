import type { GoogleGenAI } from "@google/genai";

/**
 * Gemini 底层客户端的线程内单例。aiChat/ai/gemini.ts 首次请求时填充，进程退出时
 * 随 isolate 释放；Worker 崩溃重建后按配置重新创建，容量固定为一个客户端。
 *
 * 归属 AI 闲聊 Worker：Gemini 的全部调用方（回复生成、视觉描述、贴纸整包
 * 简介）都在那条线程上，主线程侧只经消息协议要结果，不碰客户端。
 */
export const geminiClientHolder: { current: GoogleGenAI | null } = { current: null };
