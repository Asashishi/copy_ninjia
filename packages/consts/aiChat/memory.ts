/** 冷消息压缩请求在错误日志里的调用名；供应商中立，两家实现包共用。 */
export const CHAT_SUMMARY_ERROR_LABEL: string = "AI summarize API";

/** 冷消息压缩的领域参数。模型名、采样温度与输出 token 上限因供应商而异，
 *  分别放在 consts/aiChat/{gemini,openai}.ts。 */
/** HTTP 成功但摘要正文不可用时，两次业务重采样之间的退避。 */
export const SUMMARY_RETRY_DELAYS_MS: readonly number[] = [15_000, 60_000];

/** 压缩块 = 热窗口 = 镜像窗口；逐字上下文最多保留两块。 */
export const COMPACT_BATCH_SIZE: number = 128;
/** 模型请求中保留的逐字消息最大数量。 */
export const VERBATIM_CONTEXT_MAX: number = COMPACT_BATCH_SIZE * 2;
/**
 * 逐字转录分层边界的对齐粒度（条）。
 *
 * 【较早逐字记录】的长度只取本值的整数倍，因此边界每 TIER_BOUNDARY_ALIGNMENT
 * 条消息才移动一次；其余各轮转录相对上一轮是纯追加，两家供应商的自动前缀缓存
 * 能一路命中到边界处（见 aiChat/ai/utils/chatTranscript.ts 的
 * buildTieredVerbatimTranscript）。向上取整保证【最热记忆】恒不超过
 * COMPACT_BATCH_SIZE 条，与该区块标题里写死的条数一致。
 * 必须能整除 COMPACT_BATCH_SIZE，否则窗口攒满时边界落不到两块对半的位置上。
 */
export const TIER_BOUNDARY_ALIGNMENT: number = 32;
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
