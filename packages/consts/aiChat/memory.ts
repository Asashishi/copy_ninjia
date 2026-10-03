import { STATE_MANAGED_CHAT_LIMIT } from "../storage";

/** 冷消息压缩请求在错误日志里的调用名；供应商中立，各家实现包共用。 */
export const CHAT_SUMMARY_ERROR_LABEL: string = "AI summarize API";

/** HTTP 成功但摘要正文不可用时，两次业务重采样之间的退避。模型名、采样温度与输出 token 上限因供应商而异，
 *  分别放在 consts/aiChat/{gemini,openai}.ts。 */
export const SUMMARY_RETRY_DELAYS_MS: readonly number[] = [15_000, 60_000];

/**
 * 压缩块 = 热窗口 = 镜像窗口；逐字上下文最多保留两块（VERBATIM_CONTEXT_MAX）。
 * 轮换：缓存首次攒满一块时把它作为镜像提交压缩；攒满两块时滑出最旧一块（即上一轮
 * 镜像），先晋升它的摘要、再压缩留下的这一块作为新镜像（见 workers/aiChat/rollingMemory.ts
 * 的 pushBufferedMessage 与 workers/aiChat/compaction.ts 的 scheduleRotation）。
 */
export const COMPACT_BATCH_SIZE: number = 128;
/** 模型请求中保留的逐字消息最大数量。 */
export const VERBATIM_CONTEXT_MAX: number = COMPACT_BATCH_SIZE * 2;
/**
 * 逐字转录分层边界的对齐粒度（条）。
 *
 * 【较早逐字记录】的长度只取本值的整数倍，因此边界每 TIER_BOUNDARY_ALIGNMENT
 * 条消息才移动一次；其余各轮转录相对上一轮是纯追加，各家供应商的前缀缓存
 * 能一路命中到边界处（见 aiChat/ai/utils/chatTranscript.ts 的
 * buildTieredVerbatimTranscript）。向上取整保证【最热记忆】恒不超过
 * COMPACT_BATCH_SIZE 条，与该区块标题里写死的条数一致。
 * 必须能整除 COMPACT_BATCH_SIZE，否则窗口攒满时边界落不到两块对半的位置上。
 */
export const TIER_BOUNDARY_ALIGNMENT: number = 32;
/**
 * 转录已定切点的格宽（条）。
 *
 * 逐字窗口按消息序号每 TRANSCRIPT_SETTLED_SEGMENT_SIZE 条一格，最新消息所在格之前的格边界
 * 记为已定切点（见 aiChat/ai/utils/chatTranscript.ts 的 RenderedTranscript.settledOffsets），
 * 供只在区块边界命中缓存的供应商把当前会话切成多个文本块（见 aiChat/anthropic/replySession.ts）。
 * 必须能整除 TIER_BOUNDARY_ALIGNMENT，分层边界因此恒落在格边界上。
 */
export const TRANSCRIPT_SETTLED_SEGMENT_SIZE: number = 8;
/** 每群保留的冷摘要轮数。 */
export const MAX_SUMMARY_ROUNDS: number = 7;
/** 单群执行中 + 排队中的压缩任务硬顶。 */
export const COMPACTION_MAX_PENDING_PER_CHAT: number = 25;
/** dirty AI 记忆快照上报主线程的周期。 */
export const AI_SNAPSHOT_INTERVAL_MS: number = 30_000;
/** hydrate 少恢复一条，保证下一次 push 能精确命中轮换等值边界。 */
export const AI_MEMORY_HYDRATE_BUFFER_MAX: number = VERBATIM_CONTEXT_MAX - 1;
/**
 * Worker 常驻群记忆总上限，超额按最后活动时间淘汰。
 *
 * 取两倍受管群数：AI 记忆只属于受管群（`chat_states.ai_context`），但未完成的
 * teardown 最多 STATE_MANAGED_CHAT_LIMIT 项（见 aiChat/memoryMirror.ts 的
 * beginAiMemoryTeardown），旧群记忆可能与同样多的新受管群短暂并存。取值不得低于
 * 这个和，否则淘汰会落到仍在使用的受管群上。
 */
export const AI_MEMORY_MAX_CHATS: number = 2 * STATE_MANAGED_CHAT_LIMIT;
/** 单条摘要硬性字符上限。 */
export const SUMMARY_MAX_CHARS: number = 500;
/** 回复引用只保留足以辨认原消息的单行片段，避免重复整条长消息撑大上下文。 */
export const REPLY_REFERENCE_MAX_CHARS: number = 500;
