import type { AtmosphereTexts } from "../types/atmosphere";
import { chatAtmosphere } from "../infra/atmosphere";
/**
 * 广告命中后的主线程处置：写入永久黑名单并落盘，再把跨群封禁登记进 durable
 * outbox 交回 Anti-Raid Worker。候选消息构建位于 adCandidate.ts。
 */

import { logger } from "../infra/logger";
import { prefetchIdentityPolicies } from "../infra/identityStorage";
import {
  createMonotonicDeadline,
  remainingMonotonicTime,
} from "../libs/monotonicDeadline";
import { isWhitelisted } from "../infra/identityPolicy/whitelist";
import { canBypassAdDetection } from "./memberFacts";
import {
  blockUser,
  confirmBlocklistPersisted,
  managedAdminChatIds,
} from "../infra/blocklist/membership";
import { isManagedAdminChat } from "../infra/blocklist/sweepEligibility";
import { trackBlockedRemoval } from "../infra/blocklist/outbox";
import { blockedMemberRemoverHolder, blocklistIdentityMutationRunner } from "../cache/main/blocklist";
import { requestBlocklistResweep } from "../infra/blocklist/sweep";
import { getChatStateCache, getChatState } from "../infra/storage/stateStore";
import { postDiskIODiagnostic } from "../infra/diskIO";
import { sendTemporaryMessageOnMain } from "../infra/telegram/temporaryMessage";
import { inFlightAdDisposals } from "../cache/main/antiRaid/adDisposal";
import { trackBackgroundTask } from "../infra/backgroundTasks";
import { settleWithinBudget } from "../libs/inflight";
import { formatLocalTime } from "../libs/time";
import { runProtectedIdentityMutation } from "../infra/identityPolicy/coordination";
import { clearTemporaryAdBypassActivityOrThrow } from
  "../infra/identityPolicy/temporaryAdBypass";
import type {
  AdDetectedEvent,
  AdVerdictTrueEvent,
} from "../types/antiRaid/adDetect";
import type { RemoveBlockedMembersParams } from "../types/blocklist";
import type { AdSampleDiskMessage } from "../types/diskIO/messages";
import type { FlushResult } from "../types/lifecycle";

/**
 * 把这次命中的原始素材投给落盘线程（memory/ad-detected/sample.json）。
 *
 * 纯旁路：进程从不读回它，不等落盘确认、不进统一 flush、投递失败只记一行日志。
 * 投递走 postDiskIODiagnostic（见 infra/diskIO.ts）。素材供人工查看，用于调整
 * config/dynamic/ad_samples.json 的示例（见 consts/antiRaid/adDetect.ts）。
 *
 * 排在 blockUser 之前，同步记账。
 */
function recordAdSample(event: AdDetectedEvent): void {
  if (event.messages.length === 0) return;
  const posted: boolean = postDiskIODiagnostic({
    type: "adSample",
    chatId: event.chatId,
    senderId: event.senderId,
    label: event.label,
    detectedAt: formatLocalTime(Date.now()),
    reason: event.reason,
    messages: event.messages,
  } satisfies AdSampleDiskMessage);
  if (!posted) {
    logger.error(`Failed to queue the ad detection sample for sender ${event.senderId} in chat ${event.chatId}.`);
  }
}

/**
 * 执行一次判定命中的处置：先写名单再落盘，然后为每个在管群登记一批封禁并交回
 * Worker。顺序与 /block 一致：名单覆盖以后的入群，封禁覆盖此刻已知且有管理权的群。
 *
 * 重复命中同一个人（blockUser 返回 false，名单条目已存在）时只补触发群一批封禁，
 * 不再等待名单落盘，也不为其余群登记封禁批次：名单条目在第一次命中时已写进主线程
 * LRU 并投过落盘，其余群的封禁批次仍在 outbox 里等重试。
 */
async function disposeDetectedAdLocked(event: AdDetectedEvent): Promise<void> {
  // 写前重读身份策略，使互斥检查与表计数建立在当前数据库最终值上。
  if (!await prefetchIdentityPolicies([event.senderId])) return;
  const newlyBlocked: boolean | null = await runProtectedIdentityMutation(
    (): boolean | null => {
      // 写名单前复查本群广告检测开关：判定回投期间可能已执行 /ad_detect disable，
      // clearAdDetection 只清 Worker 里还没判的队列（见 antiRaid/workerBridge/controller.ts）。
      // 复查位于临界区内、紧挨着 blockUser。
      if (getChatState(event.chatId).isAdDetectEnabled !== true) return null;
      // 候选入队与模型回投之间发送者可能刚达到临时广告免检条件；
      // 在清除累计之前复查当前权限。
      if (canBypassAdDetection(event.senderId)) return null;
      // 白名单成员不写入永久黑名单；本检查同样在临时累计删除之前完成。
      if (isWhitelisted(event.senderId)) return null;
      clearTemporaryAdBypassActivityOrThrow(event.senderId);
      recordAdSample(event);
      return blockUser(event.senderId, event.meta);
    }
  );
  if (newlyBlocked === null) {
    if (getChatState(event.chatId).isAdDetectEnabled !== true) {
      logger.log(
        `Ad detection was turned off in chat ${event.chatId} before the verdict for sender ` +
        `${event.senderId} could be disposed; dropping it.`
      );
      return;
    }
    logger.error(
      `Ad detection flagged protected sender ${event.senderId} in chat ${event.chatId}; ` +
      "refusing to add the identity to the permanent blocklist."
    );
    return;
  }
  if (newlyBlocked && !await confirmBlocklistPersisted(event.senderId, false)) {
    logger.error(
      `Ad detection blocklist entry for sender ${event.senderId} is memory-only; ` +
      "it will be lost on restart."
    );
  }

  // 处置范围与 /block 同源（managedAdminChatIds），判定发生的这个群排最前。
  // 重复命中只补触发群这一批，同样过受管过滤。
  const managed: number[] = managedAdminChatIds(
    event.chatId,
    isManagedAdminChat(getChatStateCache().get(event.chatId))
  );
  const enforcementChatIds: number[] = newlyBlocked
    ? managed
    : managed.filter((chatId: number): boolean => chatId === event.chatId);
  // 逐个群登记，失败只作废这一个群；降级语义同 blocklistGuard.claimBlockedJoiner，
  // 失败的群改由补扫接手。
  const removals: RemoveBlockedMembersParams[] = [];
  let failedChats: number = 0;
  for (const chatId of enforcementChatIds) {
    try {
      removals.push(trackBlockedRemoval({
        chatId,
        userIds: [event.senderId],
        // 不探测成员关系；封禁对不在群的人同样幂等（同秒踢那一路）。
        probeMembership: false,
      }));
    } catch (error: unknown) {
      failedChats++;
      logger.error(
        `Failed to queue the ad removal of sender ${event.senderId} in chat ${chatId}:`,
        error
      );
      requestBlocklistResweep(chatId);
    }
  }
  if (removals.length === 0) {
    logger.error(
      `Ad detection has no chat to enforce the block of sender ${event.senderId} in ` +
      `(${failedChats} chat(s) failed to queue); the blocklist entry still applies to future joins.`
    );
    await announceAdDisposal(event, 0, failedChats);
    return;
  }
  if (failedChats > 0) {
    logger.error(
      `Ad detection could not queue the removal of sender ${event.senderId} in ${failedChats} chat(s); ` +
      "those chats now owe a resweep."
    );
  }
  await blockedMemberRemoverHolder.current(removals);
  logger.log(
    `Ad detection blocked sender ${event.senderId} (${event.reason || "no reason given"}) ` +
    `and queued removals in ${removals.length} chat(s).`
  );
  await announceAdDisposal(event, removals.length, failedChats);
}

/**
 * 同一身份的广告封禁与 `/block disable` 按完整副作用串行结算（cache/main/blocklist.ts 的 blocklistIdentityMutationRunner）。
 */
function disposeDetectedAd(event: AdDetectedEvent): Promise<void> {
  return blocklistIdentityMutationRunner.run(
    event.senderId,
    (): Promise<void> => disposeDetectedAdLocked(event)
  );
}

export interface FormatAdNoticeParams {
  /** 发送者的展示标签（见 users/userLabel.ts 的 formatUserLabel），由 Worker 侧算好带回。 */
  label: string;
  /** 模型给的判定理由；空串走兜底文案。 */
  reason: string;
  /** 真正登记上封禁批次的群数。 */
  enforcedChats: number;
  /** 登记失败、改由补扫接手的群数。 */
  failedChats: number;
  readonly atmosphere: AtmosphereTexts;
}

/**
 * 群内播报：只带展示标签与判定理由，不回显广告原文。模型没给理由时用兜底文案
 * （adDefaultReason）。
 *
 * 文案按真正登记上的封禁群数分三档：
 * - 一个都没登记上（outbox 触顶、刚被撤管理员、`/init disable`）：adNoManagedChat，
 *   点名请管理员介入；
 * - 部分群登记失败：adPartialBan，报真正封上的群数与失败群数；
 * - 全部登记上：adBanned。
 *
 * 文案只说记进名单与封了几个群，不提删消息：删除跑在判定线程上，主线程不知道结果，
 * 删除失败由判定线程自己记日志（见 workers/antiRaid/adDetect/disposal.ts）。
 */
export function formatAdNotice({ label, reason, enforcedChats, failedChats, atmosphere }: FormatAdNoticeParams): string {
  const head: string = atmosphere.NOTICE_TEXTS.adDetected(label, reason || atmosphere.NOTICE_TEXTS.adDefaultReason);
  if (enforcedChats === 0) {
    return atmosphere.NOTICE_TEXTS.adNoManagedChat(head);
  }
  if (failedChats > 0) {
    return atmosphere.NOTICE_TEXTS.adPartialBan(head, enforcedChats, failedChats);
  }
  return atmosphere.NOTICE_TEXTS.adBanned(head);
}

/**
 * 发播报并挂上 COMMAND_MESSAGE_AUTO_DELETE_MS 的自动清理，经统一的临时提示边界
 * （infra/telegram/temporaryMessage.ts）在拿到 id 的同步时点认领删除。
 *
 * 在主线程发送：封禁结果只有主线程知道（见 workers/antiRaid/adDetect/disposal.ts
 * 的 disposeAdSender）。整段尽力而为，失败不影响已经落定的拉黑与封禁登记；
 * bot 主动播报不带话题。
 */
async function announceAdDisposal(
  event: AdDetectedEvent,
  enforcedChats: number,
  failedChats: number
): Promise<void> {
  await sendTemporaryMessageOnMain({
    chatId: event.chatId,
    text: formatAdNotice({ label: event.label, reason: event.reason, enforcedChats, failedChats, atmosphere: chatAtmosphere() }),
  });
}

/**
 * Worker 回投的判定命中：登记成在途处置任务。事件回调是同步的，处置任务登记进
 * cache/main/antiRaid/adDisposal.ts 的 inFlightAdDisposals，由停机 drain 统一等待。
 */
export function handleAdDetected(event: AdDetectedEvent): void {
  // 名单与 outbox 都已经 durable，失败的只是这一次投递；重启恢复与下一次
  // 管理员身份观测触发的补扫都会把它接上。
  trackBackgroundTask(
    inFlightAdDisposals,
    disposeDetectedAd(event),
    `Failed to dispose the ad verdict for sender ${event.senderId}:`
  );
}

async function clearAdVerdictActivity(event: AdVerdictTrueEvent): Promise<void> {
  // 身份已经被 LRU 淘汰且冷读失败时不能按“无豁免”撤销临时成员关系。
  if (!await prefetchIdentityPolicies([event.senderId])) return;
  await runProtectedIdentityMutation((): void => {
    // 判定回投时以当前权限为准：已获临时广告豁免的成员不能被旧候选撤权。
    if (canBypassAdDetection(event.senderId)) return;
    clearTemporaryAdBypassActivityOrThrow(event.senderId);
  });
}

/** 模型明确返回 ad=true 时清空未授权累计；当前广告绕过权限优先。 */
export function handleAdVerdictTrue(event: AdVerdictTrueEvent): void {
  trackBackgroundTask(
    inFlightAdDisposals,
    clearAdVerdictActivity(event),
    `Failed to clear temporary ad bypass activity for sender ${event.senderId}:`
  );
}

/**
 * 停机排空：在预算内等待所有在途处置结算（含结算过程中新派生的）。
 *
 * 等待受 timeoutMs 预算约束；预算为 0 的路径（异常退出的 EMERGENCY_FLUSH_TIMEOUTS，见
 * docs/cn/04-invariants.md）立即结算为 timedOut。
 * @returns 全部结算为 flushed；预算用尽仍有在途为 timedOut。
 */
export async function drainAdDisposals(timeoutMs: number): Promise<FlushResult> {
  const deadline: number = createMonotonicDeadline(timeoutMs);
  while (inFlightAdDisposals.size > 0) {
    const remaining: number = remainingMonotonicTime(deadline);
    if (remaining === 0 || !await settleWithinBudget([...inFlightAdDisposals], remaining)) {
      logger.error(
        `Ad disposal drain timed out with ${inFlightAdDisposals.size} task(s) still in flight; ` +
        "the blocklist entries and removal batches stay in their durable outbox."
      );
      return "timedOut";
    }
  }
  return "flushed";
}
