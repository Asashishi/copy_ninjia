/** 冷消息压缩使用的模型与生成参数。 */
export const GEMINI_SUMMARY_MODEL: string = "gemini-3.5-flash-lite";
/** 冷消息摘要请求允许的最大输出 token。 */
export const SUMMARY_MAX_TOKENS: number = 49_152;
/** 冷消息摘要生成温度。 */
export const SUMMARY_TEMPERATURE: number = 0.5;
/** 跨请求压缩失败后的两次退避。 */
export const SUMMARY_RETRY_DELAYS_MS: readonly number[] = [15_000, 60_000];

/** 压缩块 = 热窗口 = 镜像窗口；逐字上下文最多保留两块。 */
export const COMPACT_BATCH_SIZE: number = 75;
/** 模型请求中保留的逐字消息最大数量。 */
export const VERBATIM_CONTEXT_MAX: number = COMPACT_BATCH_SIZE * 2;
/** 每群保留的冷摘要轮数。 */
export const MAX_SUMMARY_ROUNDS: number = 7;
/** 单群执行中 + 排队中的压缩任务硬顶。 */
export const COMPACTION_MAX_PENDING_PER_CHAT: number = 25;
/** dirty AI 记忆快照上报主线程的周期。 */
export const AI_SNAPSHOT_INTERVAL_MS: number = 30_000;
/** hydrate 少恢复一条，保证下一次 push 能精确命中轮换等值边界。 */
export const AI_MEMORY_HYDRATE_BUFFER_MAX: number = VERBATIM_CONTEXT_MAX - 1;
/** Worker 常驻群记忆总上限，超额按最后活动时间淘汰。 */
export const AI_MEMORY_MAX_CHATS: number = 100;
/** 单条摘要硬性字符上限。 */
export const SUMMARY_MAX_CHARS: number = 500;
/** 回复引用只保留足以辨认原消息的单行片段，避免重复整条长消息撑大上下文。 */
export const REPLY_REFERENCE_MAX_CHARS: number = 500;
/** 多层回复链回溯的最大跳数（不含触发消息本身），见 workers/aiChat/
 *  replyChain.ts；同时兜住异常数据成环时的遍历上限。 */
export const REPLY_CHAIN_MAX_DEPTH: number = 15;
/** 回复链标注里单跳正文的截断长度；链只需辨认各跳，不需要全文，全文在
 *  逐字转录里本来就有。 */
export const REPLY_CHAIN_NODE_MAX_CHARS: number = 500;
