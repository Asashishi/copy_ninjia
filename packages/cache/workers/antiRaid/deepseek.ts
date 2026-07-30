import type OpenAI from "openai";

/**
 * DeepSeek 底层客户端的线程内单例。antiRaid/ai/deepseek.ts 首次请求时填充，进程退出时
 * 随 isolate 释放；Worker 崩溃重建后按配置重新创建，容量固定为一个客户端。
 *
 * 放在 Anti-Raid Worker 名下而不是 perThread/：本项目里 DeepSeek 只有广告检测
 * 一个调用方，整条流水线都在这条线程上（见 workers/antiRaid/adDetect/）。哪天
 * 别的线程也要用它，它就该升级成 perThread/deepseek.ts——线程归属检查会先一步
 * 指出这件事。
 */
export const deepSeekClientHolder: { current: OpenAI | null } = { current: null };
