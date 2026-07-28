import { LinkedQueue } from "../../libs/linkedQueue";
import type { AdDetectedEvent } from "../../types/antiRaid";
import type { AdMessageBundle } from "../../types/antiRaid/adDetect";

/**
 * 广告检测流水线（入群守卫线程 packages/workers/antiRaid/adDetect/）的内存状态。
 *
 * 全部随 Worker isolate 生死：崩溃重建后队列与消息串一起清空，主线程不做镜像
 * ——判定本身是尽力而为的启发式，丢掉几条待检消息不影响任何安全边界，而真正
 * 不可丢的处置（拉黑 + 各群封禁）在判定命中后由主线程接管，走 /block 那条
 * durable 路径（见 docs/04-invariants.md）。
 */

/**
 * 待检发言者的键队列，元素是 `chatId:senderId`（verificationKey）。队列只排键、
 * 不排内容：同一个人在等待期间新说的话直接并进 pendingAdMessages 里的同一串，
 * 不会让他在队列里占多个位置。每个节拍取走队首至多 AD_DETECT_BATCH_SIZE 个。
 */
export const adDetectQueue: LinkedQueue<string> = new LinkedQueue<string>();

/** 当前排在 adDetectQueue 里的键；入队去重用，出队时同步删除。 */
export const queuedAdDetectKeys: Set<string> = new Set<string>();

/**
 * 本轮入队去重窗口内已经排过队的键。上面那个 Set 只覆盖「此刻还在队列里」，
 * 判定一跑完就空了；这一张覆盖整个 AD_DETECT_ENQUEUE_DEDUP_WINDOW_MS 窗口，
 * 让同一个人在窗口内只判一次，期间新说的话只并进消息串。
 *
 * 容量与待检 key 共用 AD_DETECT_MAX_PENDING_SENDERS 硬上界；窗口到点由
 * rotateAdDetectDedupWindow 一次性 clear。
 */
export const recentlyEnqueuedAdKeys: Set<string> = new Set<string>();

/**
 * 本轮窗口内已经被判成广告并处置过的键。处置到「主线程把人写进黑名单」之间
 * 有一段跨线程往返，这张表拦住那段时间里已经排在本线程的后续消息，避免同一
 * 个人被反复判定、反复触发一次完整的拉黑 + 各群封禁登记（见 adDetect.ts 的
 * disposeDetectedAd 与 docs/04-invariants.md）。与上表同一时机整表清空；届时
 * 主线程的黑名单门禁早已接管，不需要它继续记着。
 */
export const recentlyDisposedAdKeys: Set<string> = new Set<string>();

/**
 * 键 -> 该发言者累积的判定上下文。容量由 AD_DETECT_MAX_PENDING_SENDERS 兜住：
 * 满载后拒绝新的不同 key，不淘汰已经接纳的旧 key。未消费条目没有等待 TTL；
 * 已消费上下文在去重窗口外由 Worker sweep 回收。
 */
export const pendingAdMessages: Map<string, AdMessageBundle> = new Map();

/**
 * 正在等待 DeepSeek 判定的键；防止同一个人被并发送检两次，同时它的 size 就是
 * 全局在途计数，由 AD_DETECT_MAX_IN_FLIGHT 兜住上界（见 adDetect/queue.ts 的
 * runAdDetectBatch）。派发时插入，detectOne 的 finally 里删除，因此 Worker
 * 崩溃重建后随 isolate 一起归零，不需要主线程镜像。
 */
export const inFlightAdDetectKeys: Set<string> = new Set<string>();

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

/** 入队去重窗口的轮换 timer；与批处理节拍同生共死，容量固定为一个。 */
export const adDetectDedupTimer: { current: ReturnType<typeof setInterval> | null } = { current: null };

/**
 * 判定命中后回投主线程的通道（antiRaidWorker.ts 注入 self.postMessage）。
 * Worker 停止时置空，避免测试隔离下旧回调继续发消息。
 */
export const adDetectPublishHolder: { current: ((event: AdDetectedEvent) => void) | null } = { current: null };
