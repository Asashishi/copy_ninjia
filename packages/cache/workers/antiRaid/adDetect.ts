import { LinkedQueue } from "../../../libs/linkedQueue";
import type { AdDetectedEvent } from "../../../types/antiRaid/adDetect";
import type {
  AdMessageBundle,
  ReferencedAdWarningState,
} from "../../../types/antiRaid/adDetect";

/**
 * 广告检测流水线（入群守卫线程 packages/workers/antiRaid/adDetect/）的内存状态。
 *
 * 全部随 Worker isolate 生死：崩溃重建后队列与消息串一起清空，主线程不做镜像
 * ——判定本身是尽力而为的启发式，丢掉几条待检消息不影响任何安全边界，而真正
 * 不可丢的处置（拉黑 + 各群封禁）在判定命中后由主线程接管，走 /block 那条
 * durable 路径（见 docs/cn/04-invariants.md）。
 */

/**
 * 待检发言者的键队列，元素是 `chatId:senderId`（verificationKey）。队列只排键、
 * 不排内容：同一个人在等待期间新说的话直接并进 pendingAdMessages 里的同一串，
 * 不会让他在队列里占多个位置。每个节拍取走队首至多 AD_DETECT_BATCH_SIZE 个。
 */
export const adDetectQueue: LinkedQueue<string> = new LinkedQueue<string>();

/**
 * 当前排在 adDetectQueue 里的键；随队列同步增删，出队时立即删除。
 *
 * 「这个 key 已经取得一个待派发位置」由这一张表**独家**表达：排着的人再说
 * 什么都只并进消息串，不会在队列里占第二个位置。队列每个键最多一个位置，
 * 因此它的长度天然被 pendingAdMessages 的
 * 硬顶兜住，不需要独立容量闸；停管、关开关与 Worker 停止时随 adDetectQueue
 * 一起摘键，Worker 崩溃后随 isolate 从空表重建。
 */
export const queuedAdDetectKeys: Set<string> = new Set<string>();

/**
 * 各自 TTL 内已经被判成广告并处置过的键 -> **处置时刻**（同上，回拨可判）。
 * 处置到「主线程把人写进黑名单」之间有一段跨线程往返，这张表拦住那段时间里
 * 已经排在本线程的后续消息，避免同一个人被反复判定、反复触发一次完整的拉黑
 * + 各群封禁登记（见 adDetect.ts 的 disposeDetectedAd 与 docs/cn/04-invariants.md）。
 *
 * 没有任何入口闸替它把关，写入只来自处置路径，因此由 setBoundedMapValue 将
 * 容量硬顶在 AD_DETECT_MAX_PENDING_SENDERS；满载时淘汰最早处置的键。每个 key
 * 独立 TTL 到期；若封禁已取得确定结果，blocklistEffects 会立即提前回收，无需
 * 等满窗口。
 */
export const recentlyDisposedAdKeys: Map<string, number> = new Map<string, number>();

/**
 * 引用类广告已公开警告的发送者键 -> 警告失效时刻。
 *
 * owner 是 Anti-Raid Worker；第一次引用类广告警告成功后填充，五分钟到期、停管、
 * 关开关或 Worker 停止时清理，Worker 崩溃后从空表重建。容量与待检发送者上限
 * 相同；满载时淘汰最早警告，宁可让一名发送者重新获得警告，也不在没有可证明
 * 的有效警告时永久拉黑。
 */
export const referencedAdWarningStates: Map<string, ReferencedAdWarningState> =
  new Map<string, ReferencedAdWarningState>();

/**
 * 引用广告警告 attempt 的 Worker 内单调序号。清群只删状态、不回退序号，避免
 * 旧发送回执在同一 isolate 重新启用后误认领新状态；Worker 重建后连同旧回执
 * 一起消失。只在首次警告低频路径递增，不进入每消息热点。
 */
export const referencedAdWarningGeneration: { current: number } = { current: 0 };

/**
 * 键 -> 该发言者累积的判定上下文。容量由 AD_DETECT_MAX_PENDING_SENDERS 兜住：
 * 满载后拒绝新的不同 key，不淘汰已经接纳的旧 key。未消费条目没有等待 TTL；
 * 已消费上下文在去重窗口外由 Worker sweep 回收。
 */
export const pendingAdMessages: Map<string, AdMessageBundle> = new Map();

/**
 * 广告判定 system prompt 的两个静态变体，键为发送者是否仍在入群窗口。
 *
 * classifier.ts 首次使用对应变体时填充；部署配置在进程内不变，因此不失效。
 * Anti-Raid Worker 崩溃后从空表重建。没有条目表示该变体尚未构造，调用方应
 * 用当前已严格加载的广告样本生成。键域只有 boolean，容量固定为两条。
 */
export const adDetectSystemPrompts: Map<boolean, string> = new Map();

/**
 * 正在等待广告检测 provider 判定或首次公开警告发送结算的键；防止同一个人被并发
 * 送检两次，同时它的 size 就是全局在途计数，由 AD_DETECT_MAX_IN_FLIGHT 兜住
 * 上界（见 adDetect/queue.ts 的 runAdDetectBatch）。派发时插入，判定 finally
 * 释放；引用类首次命中只在警告网络往返期间同步续占，广告消息的后续删除不再
 * 占分类额度。Worker 崩溃重建后随 isolate 一起归零，不需要主线程镜像。
 */
export const inFlightAdDetectKeys: Set<string> = new Set<string>();

/**
 * 第一次警告后的广告消息清理任务。owner 为 Anti-Raid Worker；发送警告结算后
 * 填充、删除请求结算时移除，Worker 停止或崩溃时整体清空。容量独立受
 * AD_DETECT_MAX_IN_FLIGHT 约束，满载时放弃新的尽力而为清理，不能反过来占住
 * 分类 key 或无限累积 Promise。
 */
export const inFlightReferencedAdCleanupTasks: Set<Promise<void>> =
  new Set<Promise<void>>();

/**
 * 上一拍是否撞上了全局在途闸。只用来把日志压到状态边沿：撑满时每拍记一行会
 * 在故障期间自己变成刷屏源。随 isolate 生死，Worker 重建后回到 false。
 */
export const adDetectSaturated: { current: boolean } = { current: false };

/**
 * 待检 key/去重表上一轮是否撞到容量上限。只记录状态边沿，避免洪泛期间每条
 * 被拒消息都写日志；容量恢复后归零，Worker 重建后也回到 false。
 */
export const adDetectCapacitySaturated: { current: boolean } = { current: false };

/**
 * 判定流水线是否已经进入停机 quiesce。
 *
 * quiesceAdDetectQueue 置真、start/stop 置假。在途判定不登记进 Worker 的 drain
 * 集合（理由见 queue.ts 的 runAdDetectBatch），可能在主线程 drain 之后才返回；
 * detectOne 在任何处置前读取这面旗并丢弃迟到结果。
 */
export const adDetectStopping: { current: boolean } = { current: false };

/** 批处理节拍 timer；Worker 启动时创建，协作式停止时清除，容量固定为一个。 */
export const adDetectTickTimer: { current: ReturnType<typeof setInterval> | null } = { current: null };

/**
 * 判定命中后回投主线程的通道（antiRaidWorker.ts 注入 self.postMessage）。
 * Worker 停止时置空，避免测试隔离下旧回调继续发消息。
 */
export const adDetectPublishHolder: { current: ((event: AdDetectedEvent) => void) | null } = { current: null };
