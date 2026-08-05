import type { AiProviderName } from "../../../types/aiChat/provider";

/**
 * 生图供应商覆盖值在 AI 闲聊 Worker 侧的只读镜像。
 *
 * 归属 AI 闲聊 Worker：读取点是本线程上的生图工具（aiChat/ai/imageGeneration.ts
 * 经 aiChat/provider.ts 的 imageAiProvider 取用），而写入点是主线程的
 * `/image_model` 命令处理器——观测点与使用点天然跨线程，因此按 AGENTS.md
 * 「缓存与线程归属」的决策顺序走镜像：owner 变更时推送、使用侧只读。生图工具
 * 每次调用都要读一次，不能退化成 request/reply 往返。
 */

/**
 * 当前生效的生图供应商覆盖值。
 *
 * - 权威线程：主线程（权威值见 cache/main/storage.ts 的 globalModelState.image，
 *   落盘在 state.json 的 global.model.image）。
 * - 推送时机：① 超管 `/image_model` 落盘成功后立即推；② 本 Worker 重建后由
 *   主线程 aiChat/workerBridge.ts 的重放块补发；③ 进程启动时随 initAiChat 推一次。
 * - 模式：全量单值覆盖，没有增量语义——每条消息都携带完整结论。
 * - 重放方：主线程 aiChat/workerBridge.ts（onRespawn 与 initAiChat 两处）。
 * - 「无条目」（null）的 fail-safe 含义：**尚未收到任何覆盖**，生图按
 *   activeAiProvider() 的默认口径选取；不得解释为「沿用上一次的值」。Worker
 *   崩溃重建后 holder 回到 null，正确性由上面那次重放保证。
 *
 * 容量固定为一个可空值，无清理策略——它随 isolate 生灭。
 */
export const imageProviderOverrideMirror: { current: AiProviderName | null } = { current: null };
