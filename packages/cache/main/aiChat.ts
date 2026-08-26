import { AI_MEMORY_FLUSH_TIMEOUT_MS } from "../../consts/lifecycle";
import { createFlushBarrier } from "../../libs/flushBarrier";
import type { AiInitMessage } from "../../types/aiChat/protocol";
import type {
  AiChatInvalidateWaiter,
  AiMemoryDeleteWaiter,
  MoodRequestWaiter,
} from "../../types/aiChat/waiters";

/** AI 闲聊主线程侧代理（packages/aiChat/index.ts）的内存状态。 */

/**
 * AI Worker 记忆回传 barrier。模块加载时创建，Worker 终止时统一结算等待者；
 * 进程重启后以空等待表重建，容量受并发 flush 数约束。
 */
export const aiMemoryFlushBarrier: ReturnType<typeof createFlushBarrier> = createFlushBarrier({
  timeoutMs: AI_MEMORY_FLUSH_TIMEOUT_MS,
});

/** 最近一次注入 AI Worker 的 init 消息，供 Worker 崩溃重启后重放（新 Worker
 *  不知道机器人自己的账号身份），见 aiChat/index.ts 的 initAiChat/onRespawn。 */
export const lastInitState: { current: AiInitMessage | null } = { current: null };

/** 各群最新的 AI 记忆快照镜像（值是序列化 JSON 文本，与消息协议同形态，
 *  见 types/aiChat.ts 的 AiMemoryEvent.snapshot），见 aiChat/index.ts 模块头注
 *  「AI 记忆持久化」。 */
export const latestAiMemories: Map<number, string> = new Map();
/** latestAiMemories 中每份快照对应的运行时 revision。启动恢复快照统一从 0 开始。 */
export const latestAiMemoryRevisions: Map<number, number> = new Map();
/**
 * 本进程内各 chat 已分配的最高 revision；进程重启后旧消息不存在，可安全从 0 重建。
 *
 * 生命周期：nextAiMemoryRevision 与启动恢复填充，只在群 teardown 之后由
 * forgetAiMemoryRevisionCounter 删除；Worker 崩溃重启**不重建也不清空**——它描述
 * 的是本主线程进程内已分配到哪一号，与 Worker 存活无关。
 *
 * 不能按容量淘汰，也不能在 `/ai_chat disable` 时删：重置后的 revision 1 会与在途
 * 墓碑撞号，一条过期的删除回执就能把新记忆判成已删；postMemoryRecord 还用
 * 「计数器还在」表示「刚被 purge、下一条新记录要立刻落盘」。本表没有独立淘汰，
 * 上界由最多 25 个受管群约束；teardown 会同步移除对应条目。
 */
export const aiMemoryRevisionCounters: Map<number, number> = new Map();
/** 已投递但尚未收到 durable delete 回执的最新墓碑。 */
export const pendingAiMemoryDeletes: Map<number, number> = new Map();
/**
 * purge 后首份新记忆的即时持久化状态：null 表示已把强制上报标志交给 AI
 * Worker、尚未收到快照；number 表示已投给 Disk I/O、等待该 revision
 * durable。确认前保留，供 AI/Disk I/O Worker 重建时继续强制快速路径。
 */
export const postPurgeAiMemoryPersistRevisions: Map<number, number | null> = new Map();
/** 只有显式禁用/teardown 会等待；LRU 删除只保留 pending tombstone。 */
export const aiMemoryDeleteWaiters: Map<number, AiMemoryDeleteWaiter[]> = new Map();
/**
 * 已请求彻底清除记忆、正在等待 Worker 确认删除的群。用于在等待期间拒绝
 * 旧 Worker 迟到的记忆快照上报："memory" 事件到达时若群在此集合中，快照
 * 直接丢弃并改发一次 delete，不当作有效数据存进 latestAiMemories。
 * invalidateAiChat(chatId, true) 在 Worker 可用时加入；Worker 确认删除完成
 * （"memoryDeleted" 事件）或该群又开始产生新记录（recordChatMessage/
 * recordChatMedia，意味着 AI 记忆已重新启用）时移出。Worker 彻底不可用时
 * （onGiveUp/terminateAiChat）整表清空：已终止的实例不可能再回传旧快照，
 * 没有可拒绝的对象；pendingAiMemoryDeletes 由 Disk I/O 的 durable 回执
 * 独立拥有，不受这里清空影响。
 */
export const purgedAiMemoryChats: Set<number> = new Set();
/** 在途心情查询/重抽请求的等待表（requestId → waiter）：成功回执、超时或
 *  Worker 崩溃/终止时结算并删除（见 aiChat/index.ts），容量受并发
 *  /query_mood 与 /switch_mood 命令数约束。 */
export const moodRequestWaiters: Map<number, MoodRequestWaiter> = new Map();
/** 本进程内已分配的最高心情请求 requestId；进程重启后旧请求不存在，可安全从 0 重建。 */
export const moodRequestCounter: { current: number } = { current: 0 };
/** requestId → invalidate waiter；回执、超时、Worker 崩溃或终止时结算。 */
export const aiChatInvalidateWaiters: Map<number, AiChatInvalidateWaiter> = new Map();
/** 本进程内 invalidate 回执关联 ID。 */
export const aiChatInvalidateRequestCounter: { current: number } = { current: 0 };
/** Worker 是否仍可接收 invalidate 并回传 memoryDeleted；give-up 后显式关闭。 */
export const aiChatWorkerState: { available: boolean } = { available: false };
/** 各白名单贴纸包最新的目录快照镜像（同为序列化 JSON 文本），机制与
 *  latestAiMemories 完全一致（双向崩溃重放的唯一来源），见 aiChat/index.ts 模块头注。 */
export const latestStickerCatalogs: Map<string, string> = new Map();
