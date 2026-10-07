import type { AtmosphereTexts } from "../../types/atmosphere";
import { chatAtmosphere } from "../../infra/atmosphere";
import {
  gagBackgroundTasks,
  gagRuntimeAccepting,
  gagSessionCount,
  gagSessionsByChat,
} from "../../cache/main/gag";
import {
  GAG_CLEANUP_RETRY_DELAYS_MS,
  GAG_SESSION_MAX,
} from "../../consts/gag";
import { registerChatTeardown } from "../../infra/chatTeardownRegistry";
import { logger } from "../../infra/logger";
import { settleWithinBudget } from "../../libs/inflight";
import { sendCommandMessage } from "../../infra/telegram";
import type { FlushResult } from "../../types/lifecycle";
import type { ChatTeardownReason } from "../../types/chatTeardown";
import type { GagSession } from "../../types/gag";
import { releaseGagNoticeSlot } from "./notices";
import { findGagSession, trackGagBackgroundTask } from "./owner";
import {
  clearGagSpeakNoticeRefreshTimer,
  scheduleGagSpeakNoticeRefresh,
} from "./refresh";
import { DURATION_UNIT_MS } from "../../consts/commands";

export type GagEndReason = "timeout" | "ungag" | "teardown";
export type GagReservationOutcome =
  | "reserved"
  | "duplicate"
  | "full"
  | "quiescing";

/** 按对象身份删除会话，同目标的新会话不受影响。 */
function removeGagSession(session: GagSession): void {
  const sessions: GagSession[] | undefined =
    gagSessionsByChat.get(session.chatId);
  if (sessions === undefined) return;
  const index: number = sessions.indexOf(session);
  if (index === -1) return;
  if (session.timer !== null) clearTimeout(session.timer);
  if (session.cleanupTimer !== null) clearTimeout(session.cleanupTimer);
  clearGagSpeakNoticeRefreshTimer(session);
  session.timer = null;
  session.cleanupTimer = null;
  sessions.splice(index, 1);
  if (sessions.length === 0) gagSessionsByChat.delete(session.chatId);
}

/** 跨群 update 完成异步解析后，在主线程同步预约全局容量。 */
export function reserveGagSession(
  session: GagSession
): GagReservationOutcome {
  if (!gagRuntimeAccepting.current) return "quiescing";
  if (findGagSession(session.chatId, session.targetId) !== undefined) {
    return "duplicate";
  }
  if (gagSessionCount() >= GAG_SESSION_MAX) return "full";
  const sessions: GagSession[] | undefined =
    gagSessionsByChat.get(session.chatId);
  if (sessions === undefined) gagSessionsByChat.set(session.chatId, [session]);
  else sessions.push(session);
  return "reserved";
}

function clearCleanupTimer(session: GagSession): void {
  if (session.cleanupTimer === null) return;
  clearTimeout(session.cleanupTimer);
  session.cleanupTimer = null;
}

/** 认领结束：phase 置 ending 并清掉各 timer；ending 在 Telegram 收尾完成前继续占位。 */
function claimGagEnd(session: GagSession): boolean {
  if (
    findGagSession(session.chatId, session.targetId) !== session ||
    session.phase === "ending"
  ) return false;
  session.phase = "ending";
  clearGagSpeakNoticeRefreshTimer(session);
  if (session.timer !== null) clearTimeout(session.timer);
  session.timer = null;
  clearCleanupTimer(session);
  return true;
}

async function deleteGagNotices(session: GagSession): Promise<boolean> {
  if (session.noticePending) return false;
  const refreshTask: Promise<void> | null = session.speakNoticeRefreshTask;
  if (refreshTask !== null) {
    // 消息或 timer 触发的换新均由此任务持有；等待它停止改状态后，再按
    // current/pending/retired 槽位清理。
    try {
      await refreshTask;
    } catch {
      // 后台任务边界负责记录拒绝；这里回收已经登记的 Telegram 消息。
    }
  }
  let publicFinished: boolean = true;
  if (session.publicNoticeMessageId !== 0) {
    publicFinished = await releaseGagNoticeSlot(session, "publicNoticeMessageId", session.publicNoticeMessageId);
  }
  // 每个槽位先 await 删除、再并进结论：任一槽位删除失败都不得跳过后面槽位的删除。
  let speakFinished: boolean = true;
  const currentSpeakNoticeId: number = session.speakNoticeMessageId;
  if (currentSpeakNoticeId !== 0) {
    speakFinished = await releaseGagNoticeSlot(session, "speakNoticeMessageId", currentSpeakNoticeId);
  }
  const pendingSpeakNoticeId: number = session.pendingSpeakNoticeMessageId;
  if (
    pendingSpeakNoticeId !== 0 &&
    pendingSpeakNoticeId !== currentSpeakNoticeId
  ) {
    const pendingFinished: boolean =
      await releaseGagNoticeSlot(session, "pendingSpeakNoticeMessageId", pendingSpeakNoticeId);
    speakFinished = speakFinished && pendingFinished;
  } else if (pendingSpeakNoticeId === currentSpeakNoticeId) {
    session.pendingSpeakNoticeMessageId = session.speakNoticeMessageId;
  }
  const retiredSpeakNoticeId: number = session.retiredSpeakNoticeMessageId;
  if (
    retiredSpeakNoticeId !== 0 &&
    retiredSpeakNoticeId !== currentSpeakNoticeId &&
    retiredSpeakNoticeId !== pendingSpeakNoticeId
  ) {
    const retiredFinished: boolean =
      await releaseGagNoticeSlot(session, "retiredSpeakNoticeMessageId", retiredSpeakNoticeId);
    speakFinished = speakFinished && retiredFinished;
  } else if (
    retiredSpeakNoticeId === currentSpeakNoticeId ||
    retiredSpeakNoticeId === pendingSpeakNoticeId
  ) {
    session.retiredSpeakNoticeMessageId = 0;
  }
  return publicFinished && speakFinished;
}

/** 同一会话的命令、timer、teardown 与停机只能共享一条实际删除请求。 */
async function runExclusiveEndingTask(
  session: GagSession
): Promise<boolean> {
  const existing: Promise<boolean> | null = session.endingTask;
  if (existing !== null) return existing;
  const task: Promise<boolean> = deleteGagNotices(session);
  session.endingTask = task;
  try {
    return await task;
  } finally {
    if (session.endingTask === task) session.endingTask = null;
  }
}

function observeGagTask(task: Promise<boolean>): void {
  trackGagBackgroundTask(task, "Unexpected error while finishing a gag session:");
}

function scheduleCleanupRetry(session: GagSession): void {
  if (
    !gagRuntimeAccepting.current ||
    findGagSession(session.chatId, session.targetId) !== session ||
    session.phase !== "ending" ||
    session.noticePending ||
    session.cleanupTimer !== null ||
    session.cleanupRetryIndex >= GAG_CLEANUP_RETRY_DELAYS_MS.length
  ) return;
  const delayMs: number | undefined =
    GAG_CLEANUP_RETRY_DELAYS_MS[session.cleanupRetryIndex];
  if (delayMs === undefined) return;
  session.cleanupRetryIndex++;
  const timer: ReturnType<typeof setTimeout> = setTimeout(
    retryGagCleanupFromTimer,
    delayMs,
    session
  );
  timer.unref();
  session.cleanupTimer = timer;
}

function retryGagCleanupFromTimer(session: GagSession): void {
  if (session.cleanupTimer !== null) session.cleanupTimer = null;
  observeGagTask(retryGagCleanup(session));
}

/** ending 会话的显式重试入口；成功或消息已不存在时才释放 owner。 */
async function retryGagCleanup(
  session: GagSession
): Promise<boolean> {
  if (
    findGagSession(session.chatId, session.targetId) !== session ||
    session.phase !== "ending" ||
    session.noticePending
  ) return false;
  // 现有任务的创建者负责最终 remove/schedule；旁路只等待结果。
  if (session.endingTask !== null) return session.endingTask;
  clearCleanupTimer(session);
  const cleaned: boolean = await runExclusiveEndingTask(session);
  if (cleaned) removeGagSession(session);
  else scheduleCleanupRetry(session);
  return cleaned;
}

/** 命令旁路触发一次清理重试，并纳入停机可观测的后台任务集合。 */
export function requestGagCleanupRetry(session: GagSession): void {
  observeGagTask(retryGagCleanup(session));
}

/** 删除开始提示，并按结束原因决定是否发送解除提示（teardown 不发送）。 */
export async function finishGag(
  session: GagSession,
  reason: GagEndReason,
  replyToMessageId?: number
): Promise<boolean> {
  if (!claimGagEnd(session)) return false;
  if (session.noticePending) {
    // teardown（chat 停管与停机排空）强制结算并释放槽位；发送方结算时
    // commitGagNotices 发现自己已不是当前会话，转而删掉迟到的提示（见该函数的
    // findGagSession 分支）。
    if (reason === "teardown") removeGagSession(session);
    // 其余路径（/ungag、到期）不释放 owner：发送方结算后补上 message id 并接管清理。
    return true;
  }
  // endingTask 覆盖完整 Telegram 收尾（删除提示与发送解除回执）。
  const task: Promise<boolean> = (async (): Promise<boolean> => {
    const cleaned: boolean = await deleteGagNotices(session);
    try {
      if (reason !== "teardown") {
        const atmosphere: AtmosphereTexts = chatAtmosphere();
        const reasonText: string = reason === "timeout"
          ? atmosphere.NOTICE_TEXTS.gagExpired
          : atmosphere.NOTICE_TEXTS.gagRemoved;
        await sendCommandMessage({
          chatId: session.chatId,
          text: atmosphere.NOTICE_TEXTS.gagEndedNotice(reasonText, session.targetLabel, session.tool),
          replyToMessageId,
          // 解除回执落在入口所在话题（见 types/gag.ts 的同名字段）；到期路径没有
          // 可回复的消息，靠它定位话题。
          messageThreadId: session.speakNoticeThreadId,
        });
      }
    } finally {
      if (cleaned) removeGagSession(session);
      else scheduleCleanupRetry(session);
    }
    return cleaned;
  })();
  session.endingTask = task;
  try {
    await task;
  } finally {
    if (session.endingTask === task) session.endingTask = null;
  }
  return true;
}

/** active 会话到点时同步认领，再把 Telegram 收尾登记为后台任务。 */
export function expireGag(session: GagSession): void {
  observeGagTask(finishGag(session, "timeout"));
}

/** 激活预约并安装不会阻止进程退出的到期 timer。 */
function activateGag(session: GagSession): void {
  const now: number = Date.now();
  session.expiresAt = now + session.durationMinutes * DURATION_UNIT_MS.m;
  session.lastTargetMessageAt = now;
  session.phase = "active";
  session.timer = setTimeout(
    expireGag,
    session.durationMinutes * DURATION_UNIT_MS.m,
    session
  );
  session.timer.unref();
  scheduleGagSpeakNoticeRefresh(session);
}

/** 开始提示发送失败；已发出的公开/临时提示仍必须沿同一收尾边界删除。 */
export async function failGagNotice(session: GagSession): Promise<void> {
  session.noticePending = false;
  const isCurrent: boolean =
    findGagSession(session.chatId, session.targetId) === session;
  if (
    session.publicNoticeMessageId === 0 &&
    session.speakNoticeMessageId === 0 &&
    session.pendingSpeakNoticeMessageId === 0 &&
    session.retiredSpeakNoticeMessageId === 0
  ) {
    if (isCurrent) removeGagSession(session);
    return;
  }
  if (!isCurrent) {
    await deleteGagNotices(session);
    return;
  }
  if (session.phase !== "ending") claimGagEnd(session);
  await retryGagCleanup(session);
}

/**
 * 开始提示 message id 的同步登记点，由发送层在拿到 id 的那一刻回调
 * （见 infra/telegram/actions/messages.ts 的 onSent）。
 *
 * 同步执行，早于调用方的任何 await：停机 abort 打断发送时，会话仍持有该 message id，
 * 由排空按 ending 路径删除。
 *
 * 幂等：正常路径上拿到发送返回值后会再调一次。
 */
export function recordGagPublicNotice(
  session: GagSession,
  noticeMessageId: number
): void {
  session.publicNoticeMessageId = noticeMessageId;
}

/** 用户专属或频道公开开始入口的同步登记点；语义同 recordGagPublicNotice。 */
export function recordGagSpeakNotice(
  session: GagSession,
  speakNoticeMessageId: number
): void {
  session.speakNoticeMessageId = speakNoticeMessageId;
}

/**
 * 开始提示发送成功后的唯一提交点：noticePending 置 false；会话已不是当前会话时删除
 * 已登记的提示；仍为 starting 则激活；已被 teardown 认领为 ending 则沿同一清理状态机
 * 重试清理。
 */
export async function commitGagNotices(session: GagSession): Promise<void> {
  session.noticePending = false;
  if (findGagSession(session.chatId, session.targetId) !== session) {
    await deleteGagNotices(session);
    return;
  }
  if (session.phase === "starting") {
    activateGag(session);
    return;
  }
  await retryGagCleanup(session);
}

/**
 * 群停管、机器人离群或降权时静默结束 gag，并重试遗留的 ending 提示。
 *
 * reason 为 `departed` 时直接释放会话与 timer，不发起提示删除，也不留给停机排空。
 */
export async function teardownGagInChat(
  chatId: number,
  reason: ChatTeardownReason
): Promise<void> {
  const sessions: GagSession[] | undefined = gagSessionsByChat.get(chatId);
  if (sessions === undefined) return;
  const snapshot: GagSession[] = [...sessions];
  if (reason === "departed") {
    for (const session of snapshot) removeGagSession(session);
    return;
  }
  for (const session of snapshot) {
    if (session.phase === "ending") await retryGagCleanup(session);
    else await finishGag(session, "teardown");
  }
}

/** 新应用生命周期开始时重新接纳 gag 预约；不改动已有会话。 */
export function initGagRuntime(): void {
  gagRuntimeAccepting.current = true;
}

/** 停机先关闭预约入口；已有会话继续占位到提示清理完成。 */
export function quiesceGagRuntime(): void {
  gagRuntimeAccepting.current = false;
  for (const sessions of gagSessionsByChat.values()) {
    for (const session of sessions) clearGagSpeakNoticeRefreshTimer(session);
  }
}

async function settleGagRuntime(): Promise<FlushResult> {
  if (gagBackgroundTasks.size > 0) {
    await Promise.allSettled(gagBackgroundTasks);
  }
  const snapshot: GagSession[] = [];
  for (const sessions of gagSessionsByChat.values()) snapshot.push(...sessions);
  for (const session of snapshot) {
    if (session.phase === "ending") await retryGagCleanup(session);
    else await finishGag(session, "teardown");
  }
  return gagSessionsByChat.size === 0 ? "flushed" : "failed";
}

/** 在 Telegram 总闸关闭前，有界清理全部 gag 功能提示。 */
export function drainGagRuntime(timeoutMs: number): Promise<FlushResult> {
  quiesceGagRuntime();
  if (gagSessionsByChat.size === 0 && gagBackgroundTasks.size === 0) {
    return Promise.resolve("flushed");
  }
  const task: Promise<FlushResult> = settleGagRuntime().catch(
    (error: unknown): FlushResult => {
      logger.error("Unexpected error while draining gag sessions:", error);
      return "failed";
    }
  );
  if (timeoutMs <= 0) {
    void task;
    return Promise.resolve("timedOut");
  }
  return settleWithinBudget([task], timeoutMs).then(
    (settled: boolean): Promise<FlushResult> | FlushResult => settled ? task : "timedOut"
  );
}

/** 清空 timer 与缓存；只供测试隔离，不执行 Telegram 动作。 */
export function resetGagSessions(): void {
  for (const sessions of gagSessionsByChat.values()) {
    for (const session of sessions) {
      if (session.timer !== null) clearTimeout(session.timer);
      if (session.cleanupTimer !== null) clearTimeout(session.cleanupTimer);
      clearGagSpeakNoticeRefreshTimer(session);
      session.timer = null;
      session.cleanupTimer = null;
    }
  }
  gagSessionsByChat.clear();
  gagBackgroundTasks.clear();
  gagRuntimeAccepting.current = true;
}

registerChatTeardown("gag", teardownGagInChat);
