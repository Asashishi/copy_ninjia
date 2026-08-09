import type OpenAI from "openai";

/**
 * OpenAI 兼容广告检测客户端的线程内单例。antiRaid/ai/openai.ts 首次请求时填充，
 * 进程退出时随 isolate 释放；Worker 崩溃重建后按配置重建，容量固定为一个客户端。
 *
 * 仅 Anti-Raid Worker 可 import；跨线程不共享连接池或鉴权状态。
 */
export const adDetectOpenAiClientHolder: { current: OpenAI | null } = { current: null };
