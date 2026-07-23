import type { GoogleGenAI } from "@google/genai";

/**
 * Gemini 底层客户端的线程内单例。ai/gemini.ts 首次请求时填充，进程退出时
 * 随 isolate 释放；Worker 崩溃重建后按配置重新创建，容量固定为一个客户端。
 */
export const geminiClientHolder: { current: GoogleGenAI | null } = { current: null };
