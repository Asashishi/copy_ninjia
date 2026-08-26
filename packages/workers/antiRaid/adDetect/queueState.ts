/**
 * 广告判定的队列认领、容量记账与处置抑制表（入群守卫线程侧）。
 *
 * 收的是**接纳侧的判据**，三张表的入口一律经过这里：
 * - `queuedAdDetectKeys` 与 `adDetectQueue`：「已取得一个待派发位置」的唯一
 *   表达，入队必须一起增——缺一张就会让「谁在待检」出现两个互相矛盾的答案，
 *   见 docs/cn/04-invariants.md。出队释放在 queue.ts 的派发循环里，那是调度
 *   语义，两行紧挨着写才看得出它们是同一件事的两半。
 * - `pendingAdMessages`：每个发送者的消息串，撞上 AD_DETECT_MAX_PENDING_SENDERS
 *   时拒绝新的不同 key，而不是淘汰队首。
 * - `recentlyDisposedAdKeys`：逐 key 的处置抑制窗口，读到即回收；处置路径的
 *   写入在 verdict.ts，清群与停机的整表清理在 queue.ts。
 *
 * 饱和日志只在边沿记一行：撑满期间每拍记一次会让日志自己变成第二个刷屏源。
 *
 * 状态全在 cache/workers/antiRaid/adDetect.ts，随 Worker isolate 生死。
 */

import { logger } from "../../../infra/logger";
import {
  adDetectCapacitySaturated,
  adDetectQueue,
  adDetectSaturated,
  inFlightAdDetectKeys,
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
import { verificationKey } from "../../../libs/verificationKey";
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
  if (decision.action === "skip") return;
  // 两张表一起动，缺一张就会让「谁在待检」出现两个互相矛盾的答案，
  // 见 docs/cn/04-invariants.md。
  queuedAdDetectKeys.add(key);
  adDetectQueue.push(key);
}

/**
 * 把一串消息写进待检表。
 *
 * **本函数不再判容量**：唯一调用方 enqueueAdCandidate 是纯同步的，它在清洗
 * 正文之前就问过 rejectNewAdBundleAtCapacity，满载的新 key 在那里已经返回；
 * 走到这里的要么是已在表里的 key（不占新名额），要么刚通过那道闸，中间没有
 * await 让 pendingAdMessages 变化。容量判据因此只有 isNewAdBundleAtCapacity
 * 一处，不留第二道需要手工保持同步的闸。
 */
export function storeBundle(key: string, bundle: AdMessageBundle): void {
  pendingAdMessages.set(key, bundle);
  refreshAdDetectCapacitySaturation();
}

/**
 * 处置抑制记录是否仍在自己的窗口内。
 *
 * 表里存的是**处置时刻**而不是失效时刻：窗口本来就是常量，少存一个字段就少
 * 一次每键分配，更要紧的是这样才判得出墙钟回拨——`now` 落在处置时刻之前只
 * 可能是时钟往回走了，继续按失效时刻比较会把抑制拉长到「回拨幅度 + 窗口」，
 * 那段时间里这些人的每条消息都被 ignore，判定对他们整体静默停摆。同
 * referencePolicy.ts 的 hasActiveReferencedAdWarning 与 sweepReferencedAdWarnings。
 */
function adDisposalMarkerActive(disposedAt: number, now: number): boolean {
  const elapsedMs: number = now - disposedAt;
  return elapsedMs >= 0 && elapsedMs < AD_DETECT_JUDGED_RETENTION_WINDOW_MS;
}

/**
 * 读取一个 key 的处置抑制状态；失效记录就地删除，避免逻辑过期但 Map 仍增长。
 * 每个 key 独立到期，读到即回收，因此不依赖任何周期扫描保证正确性。
 */
export function hasActiveAdDisposalMarker(key: string, now: number): boolean {
  const disposedAt: number | undefined = recentlyDisposedAdKeys.get(key);
  if (disposedAt === undefined) return false;
  if (adDisposalMarkerActive(disposedAt, now)) return true;
  recentlyDisposedAdKeys.delete(key);
  return false;
}

/**
 * 回收已经过期的处置抑制记录。
 *
 * **不挂在 1 秒节拍上**：正确性由 hasActiveAdDisposalMarker 的读时回收保证，
 * 容量由 setBoundedMapValue 的硬顶保证，这里只是把「判过之后再没来过消息」
 * 的死记录从内存里清掉，5 分钟一次的维护 sweep 足够；不进入每秒一次的判定
 * 节拍，避免满载时反复扫描最多 8,192 条记录。
 */
export function expireAdDetectDisposalMarkers(now: number = Date.now()): void {
  for (const [key, disposedAt] of recentlyDisposedAdKeys) {
    if (!adDisposalMarkerActive(disposedAt, now)) recentlyDisposedAdKeys.delete(key);
  }
}

/**
 * 新发送者是否要被容量闸挡下。**纯 O(1)**：消息热路径上不做任何表扫描。
 */
export function rejectNewAdBundleAtCapacity(): boolean {
  if (!isNewAdBundleAtCapacity(pendingAdMessages.size)) return false;
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
  // pendingAdMessages.size，由那张表自己的每个删除点负责刷新。封禁批次
  // 也可能来自手工 /block 或入群秒踢，那些 key 本来就没有标记，删不到即无事。
  recentlyDisposedAdKeys.delete(verificationKey(chatId, senderId));
}

/**
 * 记录撞上/离开全局在途闸的边沿。只在翻转时记一行，撑满期间每拍记一次会让
 * 日志自己变成第二个刷屏源。已接纳 key 的待检内容没有等待 TTL，被挡下时留在
 * 队首等容量恢复，因此这里只需要把持续积压的事实点名一次。
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

/** 记录待检 key 容量撞满/恢复的边沿，避免每条被拒消息都刷一行日志。 */
export function noteAdDetectCapacitySaturation(saturated: boolean): void {
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
    pendingAdMessages.size >= AD_DETECT_MAX_PENDING_SENDERS
  );
}
