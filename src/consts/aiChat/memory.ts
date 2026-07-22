/** 冷消息压缩使用的模型与生成参数。 */
export const GEMINI_SUMMARY_MODEL: string = "gemini-3.5-flash-lite";
export const SUMMARY_MAX_TOKENS: number = 49_152;
export const SUMMARY_TEMPERATURE: number = 0.5;
/** 跨请求压缩失败后的两次退避。 */
export const SUMMARY_RETRY_DELAYS_MS: readonly number[] = [15_000, 60_000];

/** 压缩块 = 热窗口 = 镜像窗口；逐字上下文最多保留两块。 */
export const COMPACT_BATCH_SIZE: number = 75;
export const VERBATIM_CONTEXT_MAX: number = COMPACT_BATCH_SIZE * 2;
/** 每群保留的冷摘要轮数。 */
export const MAX_SUMMARY_ROUNDS: number = 7;
/** 单群执行中 + 排队中的压缩任务硬顶。 */
export const COMPACTION_MAX_PENDING_PER_CHAT: number = 21;
/** dirty AI 记忆快照上报主线程的周期。 */
export const AI_SNAPSHOT_INTERVAL_MS: number = 30_000;
/** hydrate 少恢复一条，保证下一次 push 能精确命中轮换等值边界。 */
export const AI_MEMORY_HYDRATE_BUFFER_MAX: number = VERBATIM_CONTEXT_MAX - 1;
/** Worker 常驻群记忆总上限，超额按最后活动时间淘汰。 */
export const AI_MEMORY_MAX_CHATS: number = 100;
/** 单条摘要硬性字符上限。 */
export const SUMMARY_MAX_CHARS: number = 500;
