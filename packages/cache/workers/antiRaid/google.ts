import type { GoogleGenAI } from "@google/genai";

/**
 * Owner: Anti-Raid Worker。
 *
 * Google 广告检测客户端首次请求时填充，进程退出时随 isolate 释放；Worker 崩溃
 * 重建后按 config/agent.json 的 ad_detect 能力重新创建。该线程只有一个广告检测
 * 能力，容量固定为一个客户端，无淘汰需求。
 */
export const adDetectGoogleClientHolder: { current: GoogleGenAI | null } = { current: null };
