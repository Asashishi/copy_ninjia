/** owner: workers/antiRaid。广告检测流水线（入群守卫线程 packages/workers/antiRaid/adDetect/）的内存状态。
 *
 * 全部随 Worker isolate 生死：崩溃重建后队列与消息串一起清空，主线程不做镜像。
 * 判定命中后的处置（拉黑 + 各群封禁）由主线程接管，走 /block 的 durable 路径
 * （见 docs/cn/04-invariants.md）。
 */

import { LinkedQueue } from "../../../libs/linkedQueue";
import type {
  AdDetectedEvent,
  AdDetectPrompts,
  AdMessageBundle,
  ReferencedAdWarningState,
  AdVerdictTrueEvent,
} from "../../../types/antiRaid/adDetect";

/**
 * 待检发言者的键队列，元素是 `chatId:senderId`（verificationKey，即 AdMessageBundle.key）。
 * 队列只排键、不排内容：同一个人在等待期间新说的话并进 pendingAdMessages 里的同一串，
 * 在队列里只占一个位置。每个节拍取走队首至多 AD_DETECT_BATCH_SIZE 个。
 *
 * 清理：派发时出队、停管与关开关时按群摘键、Worker 停止时整体丢弃。
 * 容量：不单独设闸，每个键最多占一个位置（由 queuedAdDetectKeys 保证），
 * 长度被 pendingAdMessages 的 AD_DETECT_MAX_PENDING_SENDERS 硬顶兜住。
 * Worker 崩溃重建：不重放，随 isolate 一起清空（见模块头注）。
 */
export const adDetectQueue: LinkedQueue<string> = new LinkedQueue<string>();

/**
 * 当前排在 adDetectQueue 里的键；随队列同步增删，出队时立即删除。
 *
 * 「这个 key 已经取得一个待派发位置」由本表表达：排着的人再说的话只并进消息串。
 * 长度被 pendingAdMessages 的硬顶兜住，不设独立容量闸；停管、关开关与 Worker 停止时
 * 随 adDetectQueue 一起摘键，Worker 崩溃后随 isolate 从空表重建。
 */
export const queuedAdDetectKeys: Set<string> = new Set<string>();

/**
 * 已被判成广告并处置过的键 -> Worker 单调时钟下的处置时刻。
 * 处置到主线程写入黑名单之间有一段跨线程往返，本表在此期间拦住本线程后续排队的
 * 同一发送者的消息（见 adDetect.ts 的 disposeDetectedAd 与 docs/cn/04-invariants.md）。
 *
 * 写入只来自处置路径，由 setBoundedMapValue 将容量硬顶在 AD_DETECT_MAX_PENDING_SENDERS，
 * 满载时淘汰最早处置的键。每个 key 在 AD_DETECT_JUDGED_RETENTION_WINDOW_MS 后到期；
 * 封禁取得确定结果时由 blocklistEffects 提前回收。Worker 重建时清空，由后续真实处置重新填充。
 */
export const recentlyDisposedAdKeys: Map<string, number> = new Map<string, number>();

/**
 * 引用类广告已公开警告的发送者键 -> 警告失效时刻。
 *
 * owner 是 Anti-Raid Worker；第一次引用类广告警告成功后填充，
 * AD_REFERENCE_WARNING_WINDOW_MS 到期、停管、关开关或 Worker 停止时清理，
 * Worker 崩溃后从空表重建。容量与待检发送者上限 AD_DETECT_MAX_PENDING_SENDERS 相同；
 * 满载时淘汰最早警告，被淘汰的发送者重新走首次警告。
 */
export const referencedAdWarningStates: Map<string, ReferencedAdWarningState> =
  new Map<string, ReferencedAdWarningState>();

/**
 * 引用广告警告 attempt 的 Worker 内单调序号。清群只删状态、不回退序号，
 * 旧发送回执据此不会认领新状态；Worker 重建后序号与旧回执一并消失。
 * 仅在首次警告路径递增。
 */
export const referencedAdWarningGeneration: { current: number } = { current: 0 };

/**
 * 群 id -> 发言者 id -> 该发言者累积的判定上下文。两层数字键，查表不拼复合键；
 * 内层表空了随即删除外层项。增删只经 workers/antiRaid/adDetect/queueState.ts
 * 的访问函数（sweep 只读遍历），条数记在 pendingAdBundleCount。
 *
 * 容量由 AD_DETECT_MAX_PENDING_SENDERS 兜住（按 pendingAdBundleCount 判）：满载后拒绝新的
 * 不同发送者，不淘汰已经接纳的旧串。未消费条目没有等待 TTL；已消费上下文在去重窗口外由
 * Worker sweep 回收。停管与关开关按群整层删除，Worker 停止时整表清空，崩溃后随 isolate 重建。
 */
export const pendingAdMessages: Map<number, Map<number, AdMessageBundle>> = new Map();

/**
 * pendingAdMessages 两层合计的消息串条数；随访问函数的增删同步维护，容量判定直接读它。
 * 清空 pendingAdMessages 时一并归零。
 */
export const pendingAdBundleCount: { current: number } = { current: 0 };

/**
 * 按当前广告示例快照拼好的判定提示词：规则与示例段，以及各系统事实变体的完整系统提示词。
 *
 * classifier.ts 首次判定时整份填充；主线程投递新的广告示例快照时由
 * workers/antiRaid/adDetect/config.ts 置 null。Anti-Raid Worker 崩溃后从 null 重建。null 表示
 * 尚未构造，调用方应用当前已严格加载的广告样本生成。容量固定为一份。
 */
export const adDetectPrompts: { current: AdDetectPrompts | null } = { current: null };

/**
 * 正在等待广告检测 provider 判定或首次公开警告发送结算的键；同一发送者不并发送检，
 * size 即全局在途计数，由 AD_DETECT_MAX_IN_FLIGHT 兜住上界
 * （见 adDetect/queue.ts 的 runAdDetectBatch）。派发时插入，判定 finally
 * 释放；引用类首次命中只在警告网络往返期间续占，广告消息的后续删除不占分类额度。
 * Worker 崩溃重建后随 isolate 归零。
 */
export const inFlightAdDetectKeys: Set<string> = new Set<string>();

/**
 * 第一次警告后的广告消息清理任务。owner 为 Anti-Raid Worker；发送警告结算后
 * 填充、删除请求结算时移除，Worker 停止或崩溃时整体清空。容量独立受
 * AD_DETECT_MAX_IN_FLIGHT 约束，满载时放弃新的清理任务，不占用分类 key。
 */
export const inFlightReferencedAdCleanupTasks: Set<Promise<void>> =
  new Set<Promise<void>>();

/** 上一拍是否撞上了全局在途闸，用于把日志限定在状态边沿。随 isolate 生死，Worker 重建后回到 false。 */
export const adDetectSaturated: { current: boolean } = { current: false };

/** 待检 key/去重表上一轮是否撞到容量上限，用于把日志限定在状态边沿；容量恢复后归零，Worker 重建后回到 false。 */
export const adDetectCapacitySaturated: { current: boolean } = { current: false };

/**
 * 判定流水线是否已经进入停机 quiesce。
 *
 * quiesceAdDetectQueue 置真、start/stop 置假。在途判定不登记进 Worker 的 drain
 * 集合（见 queue.ts 的 runAdDetectBatch），可能在主线程 drain 之后才返回；
 * detectOne 在任何处置前读取这面旗并丢弃迟到结果。
 */
export const adDetectStopping: { current: boolean } = { current: false };

/** 批处理节拍 timer；Worker 启动时创建，协作式停止时清除，容量固定为一个。 */
export const adDetectTickTimer: { current: ReturnType<typeof setInterval> | null } = { current: null };

/** 判定命中后回投主线程的通道（antiRaidWorker.ts 注入 self.postMessage）；Worker 停止时置空。 */
export const adDetectPublishHolder: {
  current: ((event: AdDetectedEvent) => void) | null;
} = { current: null };

/** ad=true 后清空主线程连续日累计的独立回投通道；测试未安装时保持为空。 */
export const adVerdictTruePublishHolder: {
  current: ((event: AdVerdictTrueEvent) => void) | null;
} = { current: null };
