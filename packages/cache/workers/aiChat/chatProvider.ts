import type { AiProviderName } from "../../../types/aiChat/provider";

/**
 * 闲聊侧供应商覆盖值在 AI 闲聊 Worker 侧的只读镜像。
 *
 * 归属 AI 闲聊 Worker：读取点是本线程上的回复会话（workers/aiChat/replyModel.ts）、
 * 纯文本（workers/aiChat/compaction.ts 与 aiChat/ai/stickers/catalog.ts）与视觉
 * 描述（aiChat/ai/imageDescription.ts），三者都经 aiChat/provider.ts 的
 * chatAiProvider 取用；写入点是主线程的 `/chat_model` 命令处理器——观测点与使用点
 * 天然跨线程，因此按 AGENTS.md「缓存与线程归属」的决策顺序走镜像：owner 变更时
 * 推送、使用侧只读。每轮回复都要读一次，不能退化成 request/reply 往返。
 *
 * 与 imageProvider.ts 是同构的两份镜像而不是一份带两个字段的：两条命令各自独立
 * 推送、互不牵连，合并只会让其中一条的推送顺带覆盖另一条的当前值。
 */

/**
 * 当前生效的闲聊侧供应商覆盖值。
 *
 * - 权威线程：主线程（权威值见 cache/main/storage.ts 的 globalModelState.chat，
 *   落盘在 state.json 的 global.model.chat）。
 * - 推送时机：① 超管 `/chat_model` 落盘成功后立即推；② 本 Worker 重建后由
 *   主线程 aiChat/workerBridge.ts 的重放块补发；③ 进程启动时随 initAiChat 推一次。
 * - 模式：全量单值覆盖，没有增量语义——每条消息都携带完整结论。
 * - 重放方：主线程 aiChat/workerBridge.ts（onRespawn 与 initAiChat 两处）。
 * - 「无条目」（null）的 fail-safe 含义：**尚未收到任何覆盖**，三项能力按
 *   activeAiProvider() 的默认口径选取；不得解释为「沿用上一次的值」。Worker
 *   崩溃重建后 holder 回到 null，正确性由上面那次重放保证。
 *
 * 容量固定为一个可空值，无清理策略——它随 isolate 生灭。
 */
export const chatProviderOverrideMirror: { current: AiProviderName | null } = { current: null };
