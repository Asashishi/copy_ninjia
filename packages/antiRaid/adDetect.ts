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
import {
  canBypassAdDetection,
  isProtectedSender,
} from "./memberFacts";
import {
  blockUser,
  confirmBlocklistPersisted,
} from "../infra/blocklist/membership";
import {
  dispatchBlockedRemovals,
  trackBlockedRemoval,
} from "../infra/blocklist/outbox";
import { requestBlocklistResweep } from "../infra/blocklist/sweep";
import { getChatStateCache, getChatState } from "../infra/storage/stateStore";
import { postDiskIODiagnostic } from "../infra/diskIO";
import { deleteMessageAfter, sendMessage } from "../infra/telegram/actions";
import { KICK_NOTICE_AUTO_DELETE_MS } from "../consts/telegram";
import { inFlightAdDisposals } from "../cache/main/antiRaid/adDisposal";
import {
  settleWithinBudget,
  trackBackgroundTask,
} from "../infra/backgroundTasks";
import { formatTokyoTime } from "../libs/time";
import {
  runBlocklistIdentityMutation,
  runProtectedIdentityMutation,
} from "../infra/identityPolicy/coordination";
import { clearTemporaryWhitelistActivity } from
  "../infra/identityPolicy/temporaryWhitelist";
import type {
  AdDetectedEvent,
  AdVerdictTrueEvent,
} from "../types/antiRaid/adDetect";
import type { RemoveBlockedMembersParams } from "../types/blocklist";
import type { AdSampleDiskMessage } from "../types/diskIO/messages";
import type { FlushResult } from "../types/lifecycle";

/** 处置目标所在的群清单：机器人已初始化且是管理员的群，同 /block 的连坐范围。 */
function managedChatIds(originChatId: number): number[] {
  const chatIds: number[] = [];
  for (const [chatId, chatState] of getChatStateCache()) {
    if (
      chatState.botPermissions?.isAdministrator !== true ||
      chatState.isInitEnabled !== true
    ) continue;
    chatIds.push(chatId);
  }
  // 判定发生的这个群排最前：那里正躺着刚发出来的广告，最该先封。
  return chatIds.includes(originChatId)
    ? [originChatId, ...chatIds.filter((chatId: number): boolean => chatId !== originChatId)]
    : chatIds;
}

/**
 * 把这次命中的原始素材投给落盘线程（memory/ad-detected/sample.json）。
 *
 * 纯旁路：进程从不读回它，丢了也不影响任何行为，因此不等落盘确认、不进统一
 * flush、投递失败只记一行日志。投递走 postDiskIODiagnostic：postDiskIO 在
 * Worker 恢复窗口里会占那份触顶即致命停机的重放缓冲，而这条样本体积最大、
 * 命中时最密集，不该拿一个纯诊断把进程送走（见 infra/diskIO.ts）。
 * 它存在的唯一目的是让人回头翻原文，据此调
 * config/ad_samples.json 的判定口径——判定规则由提示词定死，题材口径全靠那份
 * 示例，而示例只能从真实命中里攒（见 consts/antiRaid/adDetect.ts）。
 *
 * 排在 blockUser 之前：这一步是同步记账，而下面几步要等落盘与投递屏障，中途
 * 任何一步抛错都会让这条素材连同事件一起消失——而它恰恰是「这次判得对不对」
 * 的唯一证据。误判时尤其如此：人得先看到原文才知道该往示例里加什么、减什么。
 */
function recordAdSample(event: AdDetectedEvent): void {
  if (event.messages.length === 0) return;
  const posted: boolean = postDiskIODiagnostic({
    type: "adSample",
    chatId: event.chatId,
    senderId: event.senderId,
    label: event.label,
    detectedAt: formatTokyoTime(Date.now()),
    reason: event.reason,
    messages: event.messages,
  } satisfies AdSampleDiskMessage);
  if (!posted) {
    logger.error(`Failed to queue the ad detection sample for sender ${event.senderId} in chat ${event.chatId}.`);
  }
}

/**
 * 执行一次判定命中的处置：先写名单再落盘，然后为每个在管群登记一批封禁并交回
 * Worker。顺序与 /block 一致——名单覆盖的是「以后」，封禁只覆盖此刻已知且有
 * 管理权的群，两者不能互相替代。
 *
 * 重复命中同一个人时只补这个群一批封禁，不再重走整套。判定是自动触发的，同一
 * 个刷屏号在封禁落地之前完全可能被再判一次（Worker 侧另有一层窗口内抑制，但
 * 跨窗口拦不住），而整套处置的代价是「一次带 fsync 的黑名单落盘 + 每个在管群
 * 各一批封禁，每批都要整份 outbox 深拷贝并落盘」——按群数放大的 O(n²) 写盘，
 * 正是 docs/cn/04-invariants.md 点名要避开的形态。名单条目在第一次命中时就已写进
 * 主线程 LRU 并投过落盘（那一次若没写成，日志里已经点名，且 Disk I/O Worker 重建
 * 会重放本进程新增的条目），其余群的封禁批次也还在 outbox 里等重试；重来一遍
 * 换不到任何新东西。这与 `/block` 的重试语义不冲突：那条路的重复调用是管理员
 * 修好磁盘后的人为重试，这条路是刷屏号自己触发的，两者不该共用一套代价。
 */
async function disposeDetectedAdLocked(event: AdDetectedEvent): Promise<void> {
  // 候选入队时虽已预热，但模型往返期间该身份可能被 8192 项 LRU 淘汰；写前重读
  // 一次，确保互斥检查与表计数建立在当前数据库最终值上。
  if (!await prefetchIdentityPolicies([event.senderId])) return;
  const newlyBlocked: boolean | null = await runProtectedIdentityMutation(
    (): boolean | null => {
      // 判定发生在 Worker 侧，事件回投主线程后还要排过 identity 串行队列才轮到
      // 这里；这中间完全可能夹进一条 /ad_detect disable —— 它翻标志、落盘、调
      // clearAdDetection，而 clearAdDetection 只清得掉 Worker 里还没判的队列，
      // 够不到一条已经发布出来的判定。不在写名单之前复查一次的话，开关关掉之后
      // 仍然会有人被写进永久黑名单、在所有托管群封禁并被群内公告点名，正是
      // clearAdDetection 存在的意义（见 antiRaid/workerBridge.ts）。复查放在临界
      // 区内、紧挨着 blockUser：再往后就过了不可逆点，那时候撤只会留下一条既成
      // 事实的名单条目却没有任何执行。
      if (getChatState(event.chatId).isAdDetectEnabled !== true) return null;
      // 候选入队与模型回投之间，发送者可能刚达到临时白名单条件。
      // 临时白名单只提供广告绕过，因此必须在清除累计之前复查当前权限；
      // 旧判定不得先撤权再把成员写进黑名单。
      if (canBypassAdDetection(event.senderId)) return null;
      // 即使白名单成员显式关掉广告绕过，模型也只能处理本批消息，
      // 不得把成员写入永久黑名单。本检查同样要在临时累计删除之前完成。
      if (isProtectedSender(event.senderId)) return null;
      if (!clearTemporaryWhitelistActivity(event.senderId)) {
        throw new Error(
          `Temporary whitelist reset for identity ${event.senderId} was rejected by the persistence Worker.`
        );
      }
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
  if (newlyBlocked && !await confirmBlocklistPersisted()) {
    logger.error(
      `Ad detection blocklist entry for sender ${event.senderId} is memory-only; ` +
      "it will be lost on restart."
    );
  }

  // 重复命中只补触发群这一批，且照样过 managedChatIds 那道过滤：两次命中之间
  // 机器人可能刚被撤管理员或这个群刚 /init disable，那时连这一批也不该登记。
  const managed: number[] = managedChatIds(event.chatId);
  const enforcementChatIds: number[] = newlyBlocked
    ? managed
    : managed.filter((chatId: number): boolean => chatId === event.chatId);
  // 逐个群登记，失败只作废这一个群。整段用 map 的话，trackBlockedRemoval 中途
  // 抛出（outbox 满、id 空间耗尽）会让已登记的几批留在 outbox 里而
  // dispatchBlockedRemovals 一次都调不到，这人在**所有**群都封不掉。降级语义同
  // blocklistGuard.claimBlockedJoiner，失败的群改由补扫接手。
  const removals: RemoveBlockedMembersParams[] = [];
  let failedChats: number = 0;
  for (const chatId of enforcementChatIds) {
    try {
      removals.push(trackBlockedRemoval({
        chatId,
        userIds: [event.senderId],
        // 探测省不掉一次网络往返却救不了什么：目标此刻多半就在群里，而封禁本身
        // 对不在群的人也是幂等的（同秒踢那一路）。
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
  await dispatchBlockedRemovals(removals);
  logger.log(
    `Ad detection blocked sender ${event.senderId} (${event.reason || "no reason given"}) ` +
    `and queued removals in ${removals.length} chat(s).`
  );
  await announceAdDisposal(event, removals.length, failedChats);
}

/**
 * 同一身份的广告封禁与 `/unblock` 必须覆盖完整副作用后串行结算。只锁名单写入
 * 会让这里等待落盘时被 `/unblock` 越过，随后又登记一批已经过期的封禁。
 */
function disposeDetectedAd(event: AdDetectedEvent): Promise<void> {
  return runBlocklistIdentityMutation(
    event.senderId,
    (): Promise<void> => disposeDetectedAdLocked(event)
  );
}

export interface FormatAdNoticeParams {
  /** 发送者的展示标签（昵称/频道名 + id），由 Worker 侧算好带回。 */
  label: string;
  /** 模型给的判定理由；空串走兜底文案。 */
  reason: string;
  /** 真正登记上封禁批次的群数。 */
  enforcedChats: number;
  /** 登记失败、改由补扫接手的群数。 */
  failedChats: number;
}

/**
 * 群内播报：只带展示标签与判定理由，不回显广告原文（回显等于替广告再发一遍）。
 * 模型没给理由时用兜底文案——这条消息存在的意义就是说清「为什么这个人没了」，
 * 不能空着。导出仅为可测试性。
 *
 * 文案按**真正登记上的封禁群数**分三岔，一个群都不能多说：
 * - 一个都没登记上（outbox 触顶、刚被撤管理员、`/init disable`）时人根本没被踢走，
 *   这时说「在所有盯着的群里一起封掉了」就是一条与事实相反的公告，改成点名请
 *   管理员介入；
 * - 部分群登记失败时那些群里人还坐着，只报真正封上的群数并把欠账说出来——否则
 *   「在所有盯着的群里」同样是假话，而唯一的线索只是一行没人看的日志；
 * - 全部登记上才是那句「一起封掉了」。
 *
 * **不提删消息**。删除跑在判定线程上、排在本事件回投之后，主线程压根不知道它
 * 成没成；而机器人完全可能是「有 can_restrict_members、没有 can_delete_messages」
 * 的管理员，那种群里广告原封不动挂着、公告却写着「已经删干净」，是一条群成员
 * 一眼就能证伪的假话。只说这边确证得了的两件事：记进名单、封了几个群。
 * 删除失败由判定线程自己记日志（见 workers/antiRaid/adDetect/disposal.ts）。
 */
export function formatAdNotice({ label, reason, enforcedChats, failedChats }: FormatAdNoticeParams): string {
  const head: string = `哼，${label} 被本天才当广告封了，理由：${reason || "整串消息通篇都是推广引流"}。`;
  if (enforcedChats === 0) {
    return `${head}人已经记进小本本了；可本天才现在一个群都封不动，杂鱼管理员快来看看本天才的权限♡`;
  }
  if (failedChats > 0) {
    return `${head}人已经记进小本本、在 ${enforcedChats} 个群封掉了，还有 ${failedChats} 个群没封动，` +
      "杂鱼管理员快来看看本天才在那边的权限♡";
  }
  return `${head}人已经记进小本本、在所有盯着的群里一起封掉了♡`;
}

/**
 * 发播报并挂上自动清理。播报本身 KICK_NOTICE_AUTO_DELETE_MS（30 秒）后自删，
 * 与超时踢人的战报同一条约定，不给群里留一条永久的公告。
 *
 * 发在主线程而不是判定线程：文案要断言封禁结果，而结果只有这边知道（理由见
 * workers/antiRaid/adDetect/disposal.ts 的 disposeAdSender）。整段尽力而为，
 * 失败不影响已经落定的拉黑与封禁登记。
 *
 * 删除 owner 必须在 `onSent` 里、拿到 id 的同步时点认领，不能等 await 的返回值：
 * runTelegramAction 先跑 map（onSent 在其中）再检查 update 取消，远端已收下却恰好
 * 撞上停机 abort 时它抛错、返回值丢失，而这条播报已经挂在群里了——认领点写在
 * await 之后就等于把它永久留下。口径同 infra/telegram/commandMessages.ts 与
 * infra/telegram/temporaryMessage.ts；batchOnFlush 让同群公告合批成一次 deleteMessages。
 */
async function announceAdDisposal(
  event: AdDetectedEvent,
  enforcedChats: number,
  failedChats: number
): Promise<void> {
  await sendMessage({
    chatId: event.chatId,
    text: formatAdNotice({ label: event.label, reason: event.reason, enforcedChats, failedChats }),
    onSent: (noticeMessageId: number): void => {
      deleteMessageAfter({
        chatId: event.chatId,
        messageId: noticeMessageId,
        delayMs: KICK_NOTICE_AUTO_DELETE_MS,
        batchOnFlush: true,
      });
    },
  });
}

/**
 * Worker 回投的判定命中：登记成在途处置任务。事件回调是同步的，而处置要等
 * 落盘与投递屏障，因此挂进 cache/main/antiRaid/adDisposal.ts 的集合里，由停机 drain
 * 统一等待，不让它在半路被丢掉。
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
    if (clearTemporaryWhitelistActivity(event.senderId)) return;
    throw new Error(
      `Temporary whitelist reset for identity ${event.senderId} was rejected by the persistence Worker.`
    );
  });
}

/** 模型明确返回 ad=true 时清空未授权累计；当前广告绕过权限优先。 */
export function handleAdVerdictTrue(event: AdVerdictTrueEvent): void {
  trackBackgroundTask(
    inFlightAdDisposals,
    clearAdVerdictActivity(event),
    `Failed to clear temporary whitelist activity for sender ${event.senderId}:`
  );
}

/**
 * 停机排空：在预算内等待所有在途处置结算（含结算过程中新派生的）。
 *
 * 预算不能省。处置内部要走 confirmBlocklistPersisted（一次带 fsync 的领域 flush）
 * 与 dispatchBlockedRemovals（outbox 写前落盘 + mailbox 屏障），裸等的话，异常
 * 退出那条把全部预算设成 0 的路径（EMERGENCY_FLUSH_TIMEOUTS，见
 * docs/cn/04-invariants.md）本该立刻结算成 timedOut，实际会一路拖到 15 秒强制退出
 * ——进程带非零码死在停机中途，实例锁不释放、offset 不确认。
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
