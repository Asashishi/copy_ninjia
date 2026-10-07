/**
 * 广告判定的队列认领、容量记账与处置抑制表（入群守卫线程侧）。
 *
 * 收的是**接纳侧的判据**，三张表的入口一律经过这里：
 * - `queuedAdDetectKeys` 与 `adDetectQueue`：「已取得一个待派发位置」的唯一
 *   表达，入队时一起增（见 docs/cn/04-invariants.md）；出队释放在 queue.ts 的
 *   派发循环里。
 * - `pendingAdMessages`：每个发送者的消息串（群 -> 发送者两层表），撞上
 *   AD_DETECT_MAX_PENDING_SENDERS 时拒绝新的不同 key。读写一律经本文件的
 *   访问函数，条数同步记在 `pendingAdBundleCount`。
 * - `recentlyDisposedAdKeys`：逐 key 的处置抑制窗口，读到即回收；处置路径的
 *   写入在 verdict.ts，清群与停机的整表清理在 queue.ts。
 *
 * 饱和日志只在边沿记一行。
 *
 * 状态全在 cache/workers/antiRaid/adDetect.ts，随 Worker isolate 生死。
 */

import { logger } from "../../../infra/logger";
import {
  adDetectCapacitySaturated,
  adDetectQueue,
  adDetectSaturated,
  inFlightAdDetectKeys,
  pendingAdBundleCount,
  pendingAdMessages,
  queuedAdDetectKeys,
  recentlyDisposedAdKeys,
} from "../../../cache/workers/antiRaid/adDetect";
import {
  AD_DETECT_JUDGED_RETENTION_WINDOW_MS,
  AD_DETECT_MAX_IN_FLIGHT,
  AD_DETECT_MAX_PENDING_SENDERS,
} from "../../../consts/antiRaid/adDetect";
import {
  admitAdRequeue,
  isNewAdBundleAtCapacity,
} from "../../../states/adDetectAdmission";
import { latestSeq } from "./bundle";
import { requireVerificationKey, verificationKey } from "../../../libs/verificationKey";
import type { ParsedVerificationKey } from "../../../libs/verificationKey";
import type { AdMessageBundle } from "../../../types/antiRaid/adDetect";
import type { AdRequeueDecision } from "../../../types/states/adDetectAdmission";

/**
 * 键已经不在队列里、且还有没判过的消息时排队；已经排队或在途的键都不重复排。
 * 判据是纯标量的，与时钟无关——待检位置没有 TTL，排多久都不会自己过期。
 */
export function requeueIfUnchecked(key: string, bundle: AdMessageBundle): void {
  const decision: AdRequeueDecision = admitAdRequeue({
    hasUncheckedContent: latestSeq(bundle) > bundle.checkedSeq,
    queued: queuedAdDetectKeys.has(key),
    inFlight: inFlightAdDetectKeys.has(key),
  });
  if (decision === "skip") return;
  // 两张表一起增，见 docs/cn/04-invariants.md。
  queuedAdDetectKeys.add(key);
  adDetectQueue.push(key);
}

/** 某群某发送者此刻的消息串。 */
export function pendingAdBundle(chatId: number, senderId: number): AdMessageBundle | undefined {
  return pendingAdMessages.get(chatId)?.get(senderId);
}

/** 按队列里的键取消息串；键只来自本线程的 AdMessageBundle.key。 */
export function pendingAdBundleForKey(key: string): AdMessageBundle | undefined {
  const parsed: ParsedVerificationKey = requireVerificationKey(key);
  return pendingAdBundle(parsed.chatId, parsed.userId);
}

/**
 * 把一串新消息写进待检表；已在表里的串原地更新，不经过这里。
 *
 * **本函数不判容量**：唯一调用方 enqueueAdCandidate 同步执行，已在清洗正文之前经
 * rejectNewAdBundleAtCapacity 拦下满载的新 key，容量判据只有
 * isNewAdBundleAtCapacity 一处。
 */
export function storeBundle(bundle: AdMessageBundle): void {
  let bundles: Map<number, AdMessageBundle> | undefined = pendingAdMessages.get(bundle.chatId);
  if (bundles === undefined) {
    bundles = new Map();
    pendingAdMessages.set(bundle.chatId, bundles);
  }
  bundles.set(bundle.senderId, bundle);
  pendingAdBundleCount.current++;
  refreshAdDetectCapacitySaturation();
}

/** 删掉某群某发送者的消息串；不存在时什么都不做。容量状态由调用方按需刷新。 */
export function deletePendingAdBundle(chatId: number, senderId: number): void {
  const bundles: Map<number, AdMessageBundle> | undefined = pendingAdMessages.get(chatId);
  if (bundles?.delete(senderId) !== true) return;
  pendingAdBundleCount.current--;
  if (bundles.size === 0) pendingAdMessages.delete(chatId);
}

/** 停管或关开关：整层删掉这个群的全部消息串。 */
export function deletePendingAdBundlesInChat(chatId: number): void {
  const bundles: Map<number, AdMessageBundle> | undefined = pendingAdMessages.get(chatId);
  if (bundles === undefined) return;
  pendingAdBundleCount.current -= bundles.size;
  pendingAdMessages.delete(chatId);
}

/** 临时免检：删掉这个身份在各群的消息串。 */
export function deletePendingAdBundlesOfSender(senderId: number): void {
  for (const [chatId, bundles] of pendingAdMessages) {
    if (!bundles.delete(senderId)) continue;
    pendingAdBundleCount.current--;
    if (bundles.size === 0) pendingAdMessages.delete(chatId);
  }
}

/** Worker 停止：清空全部消息串。 */
export function clearPendingAdBundles(): void {
  pendingAdMessages.clear();
  pendingAdBundleCount.current = 0;
}

/**
 * 处置抑制记录是否仍在自己的窗口内。
 *
 * 表里存 Worker 开始处置时的单调时钟，读取也使用本线程 performance.now()。
 * 主线程观测时间用于消息上下文与引用警告窗口，不参与处置 TTL；排队等待与墙钟调整不会
 * 缩短或延长该窗口。跨模块约束见 docs/cn/04-invariants.md。
 */
function adDisposalMarkerActive(disposedAt: number, now: number): boolean {
  const elapsedMs: number = now - disposedAt;
  return elapsedMs >= 0 && elapsedMs < AD_DETECT_JUDGED_RETENTION_WINDOW_MS;
}

/**
 * 读取一个 key 的处置抑制状态；失效记录读到即删除。每个 key 独立到期，
 * 正确性不依赖周期扫描。
 */
export function hasActiveAdDisposalMarker(key: string): boolean {
  const disposedAt: number | undefined = recentlyDisposedAdKeys.get(key);
  if (disposedAt === undefined) return false;
  if (adDisposalMarkerActive(disposedAt, performance.now())) return true;
  recentlyDisposedAdKeys.delete(key);
  return false;
}

/**
 * 回收已经过期的处置抑制记录。
 *
 * 挂在维护 sweep（sweepAdDetect）上，不进判定节拍：正确性由 hasActiveAdDisposalMarker
 * 的读时回收保证，容量由 setBoundedMapValue 的硬顶保证，这里清掉判过之后再没来过
 * 消息的过期记录。
 */
export function expireAdDetectDisposalMarkers(now: number = performance.now()): void {
  for (const [key, disposedAt] of recentlyDisposedAdKeys) {
    if (!adDisposalMarkerActive(disposedAt, now)) recentlyDisposedAdKeys.delete(key);
  }
}

/**
 * 新发送者是否要被容量闸挡下。**纯 O(1)**：消息热路径上不做任何表扫描。
 */
export function rejectNewAdBundleAtCapacity(): boolean {
  if (!isNewAdBundleAtCapacity(pendingAdBundleCount.current)) return false;
  noteAdDetectCapacitySaturation(true);
  return true;
}

/**
 * 封禁已在 Telegram 取得确定结果后立即释放该发送者的处置 TTL 记录。
 * 入队认领早在派发时释放；主线程黑名单已在封禁批次投递前落定，后续消息由
 * blocked 门禁接管。
 */
export function releaseAdDetectDedupKey(chatId: number, senderId: number): void {
  // 只动处置抑制表：待检表与队列认领都不属于本链路，容量状态也只看
  // pendingAdBundleCount，由那张表自己的每个删除点负责刷新。封禁批次
  // 也可能来自手工 /block 或入群秒踢，那些 key 本来就没有标记，删不到即无事。
  recentlyDisposedAdKeys.delete(verificationKey(chatId, senderId));
}

/**
 * 记录撞上/离开全局在途闸的边沿，只在翻转时记一行。被挡下的已接纳 key 留在
 * 队首等容量恢复，这里把持续积压的事实点名一次。
 */
export function noteAdDetectSaturation(saturated: boolean): void {
  if (saturated === adDetectSaturated.current) return;
  adDetectSaturated.current = saturated;
  logger.error(saturated
    ? `Ad detection reached its ${AD_DETECT_MAX_IN_FLIGHT} in-flight ceiling; ` +
      `${adDetectQueue.size} accepted key(s) remain queued.`
    : "Ad detection dropped back below its in-flight ceiling."
  );
}

/** 记录待检 key 容量撞满/恢复的边沿，只在翻转时记一行。 */
function noteAdDetectCapacitySaturation(saturated: boolean): void {
  if (saturated === adDetectCapacitySaturated.current) return;
  adDetectCapacitySaturated.current = saturated;
  logger.error(saturated
    ? `Ad detection reached its ${AD_DETECT_MAX_PENDING_SENDERS} pending-key ceiling; ` +
      "new distinct senders will be rejected until capacity recovers."
    : "Ad detection pending-key capacity recovered below its ceiling."
  );
}

/** 按待检表的现场刷新容量状态；它是唯一一张会撞上接纳硬顶的表。 */
export function refreshAdDetectCapacitySaturation(): void {
  noteAdDetectCapacitySaturation(
    isNewAdBundleAtCapacity(pendingAdBundleCount.current)
  );
}
