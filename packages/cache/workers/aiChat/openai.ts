import type OpenAI from "openai";

/**
 * OpenAI 底层客户端的线程内单例。aiChat/openai/client.ts 首次请求时填充，
 * 进程退出时随 isolate 释放；Worker 崩溃重建后按配置重新创建，容量固定为
 * 一个客户端。
 *
 * 归属 AI 闲聊 Worker：AI 闲聊供应商的全部调用方（回复生成、视觉描述、
 * 记忆压缩、贴纸整包简介、生图）都在那条线程上，主线程侧只经消息协议要
 * 结果，不碰客户端。
 *
 * 与 cache/workers/aiChat/gemini.ts **可以同时非空**：供应商是按能力分别选的
 * （aiChat/provider.ts 的 chatAiProvider / imageAiProvider），因此「闲聊留在
 * Gemini、生图切到 OpenAI」（`/image_model gpt`）这种组合下，一条线程上两家的
 * 客户端都会被首次调用填上，并一直留到 Worker 结束。不要按「同一时刻只有一家
 * 活着」推断——尤其不能在切换供应商时顺手清掉「另一个」holder：那会把仍在服务
 * 另一种能力的客户端拆掉。按能力分路选取的完整表述见 docs/04-invariants.md。
 *
 * 注意与 cache/workers/antiRaid/deepseek.ts 的区别：那份属于入群守卫线程、
 * 服务广告检测，两条线各用各的客户端与凭据，不共享也不回退。
 */
export const openAiClientHolder: { current: OpenAI | null } = { current: null };
