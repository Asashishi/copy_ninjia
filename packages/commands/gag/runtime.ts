import {
  gagBackgroundTasks,
  gagRuntimeAccepting,
  gagSessionsByChat,
} from "../../cache/main/gag";
import {
  GAG_CLEANUP_RETRY_DELAYS_MS,
  GAG_SESSION_MAX,
} from "../../consts/gag";
import { registerChatTeardown } from "../../infra/chatTeardown";
import { logger } from "../../infra/logger";
import {
  deleteEphemeralMessageWithOutcome,
  deleteMessageWithOutcome,
  sendCommandMessage,
} from "../../infra/telegram";
import type { DeleteMessageOutcome } from "../../infra/telegram";
import type { FlushResult } from "../../types/lifecycle";
import type { GagSession } from "../../types/gag";

export type GagEndReason = "timeout" | "ungag" | "teardown";
export type GagReservationOutcome =
  | "reserved"
  | "duplicate"
  | "full"
  | "quiescing";

/** 在当前群的小列表中按目标 id 定位会话。 */
export function findGagSession(
  chatId: number,
  targetId: number
): GagSession | undefined {
  const sessions: GagSession[] | undefined = gagSessionsByChat.get(chatId);
  return sessions?.find((session: GagSession): boolean =>
    session.targetId === targetId
  );
}

/** 删除精确的会话对象；同目标的新会话不会被旧收尾误删。 */
export function removeGagSession(session: GagSession): boolean {
  const sessions: GagSession[] | undefined =
    gagSessionsByChat.get(session.chatId);
  if (sessions === undefined) return false;
  const index: number = sessions.indexOf(session);
  if (index === -1) return false;
  if (session.timer !== null) clearTimeout(session.timer);
  if (session.cleanupTimer !== null) clearTimeout(session.cleanupTimer);
  session.timer = null;
  session.cleanupTimer = null;
  sessions.splice(index, 1);
  if (sessions.length === 0) gagSessionsByChat.delete(session.chatId);
  return true;
}

/** 跨群 update 完成异步解析后，在主线程同步预约全局容量。 */
export function reserveGagSession(
  session: GagSession
): GagReservationOutcome {
  if (!gagRuntimeAccepting.current) return "quiescing";
  if (findGagSession(session.chatId, session.targetId) !== undefined) {
    return "duplicate";
  }
  let count: number = 0;
  for (const sessions of gagSessionsByChat.values()) count += sessions.length;
  if (count >= GAG_SESSION_MAX) return "full";
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

/** ending 在 Telegram 收尾完成前继续占位，旧任务不能穿插同目标的新会话。 */
function claimGagEnd(session: GagSession): boolean {
  if (
    findGagSession(session.chatId, session.targetId) !== session ||
    session.phase === "ending"
  ) return false;
  session.phase = "ending";
  if (session.timer !== null) clearTimeout(session.timer);
  session.timer = null;
  clearCleanupTimer(session);
  return true;
}

function deletionFinished(outcome: DeleteMessageOutcome): boolean {
  return outcome === "deleted" || outcome === "gone";
}

async function deleteGagNotices(session: GagSession): Promise<boolean> {
  if (session.noticePending) return false;
  let publicFinished: boolean = true;
  if (session.publicNoticeMessageId !== 0) {
    const publicOutcome: DeleteMessageOutcome = await deleteMessageWithOutcome(
      session.chatId,
      session.publicNoticeMessageId
    );
    publicFinished = deletionFinished(publicOutcome);
  }
  let ephemeralFinished: boolean = true;
  if (session.ephemeralNoticeMessageId !== 0 && session.targetId > 0) {
    const ephemeralOutcome: DeleteMessageOutcome =
      await deleteEphemeralMessageWithOutcome({
        chatId: session.chatId,
        receiverUserId: session.targetId,
        ephemeralMessageId: session.ephemeralNoticeMessageId,
      });
    ephemeralFinished = deletionFinished(ephemeralOutcome);
  }
  return publicFinished && ephemeralFinished;
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
  const observed: Promise<void> = task
    .then((): void => undefined)
    .catch((error: unknown): void => {
      logger.error("Unexpected error while finishing a gag session:", error);
    })
    .finally((): void => {
      gagBackgroundTasks.delete(observed);
    });
  gagBackgroundTasks.add(observed);
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
export async function retryGagCleanup(
  session: GagSession
): Promise<boolean> {
  if (
    findGagSession(session.chatId, session.targetId) !== session ||
    session.phase !== "ending" ||
    session.noticePending
  ) return false;
  // 现有任务的创建者负责最终 remove/schedule；旁路只等待结果，不能在原始
  // finishGag 尚未发送解除回执时提前释放槽位。
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

/** 删除开始提示，并按原有结束原因决定是否发送一条 30 秒解除提示。 */
export async function finishGag(
  session: GagSession,
  reason: GagEndReason,
  replyToMessageId?: number
): Promise<boolean> {
  if (!claimGagEnd(session)) return false;
  if (session.noticePending) {
    // teardown（chat 停管与停机排空）必须能强制结算：它是有预算的最后一遍，
    // 留着这条会话只会让 drainGagRuntime 恒判 failed、进程带非零码退出并扣住
    // 实例锁。释放槽位是安全的——发送方结算时 commitGagNotices 会发现自己已不是
    // 当前会话，转而删掉那条迟到的提示（见该函数的 findGagSession 分支）。
    if (reason === "teardown") removeGagSession(session);
    // 其余路径（/ungag、到期）不释放 owner：发送方结算后会补上 message id 并
    // 接管清理，此时抢先释放会让同目标的新会话与旧收尾互相踩踏。
    return true;
  }
  // endingTask 覆盖完整 Telegram 收尾，而不只覆盖删除请求；否则提示已删除、
  // 解除回执仍在途的窗口会被另一条 `/ungag` 或停机 drain 提前释放槽位。
  const task: Promise<boolean> = (async (): Promise<boolean> => {
    const cleaned: boolean = await deleteGagNotices(session);
    try {
      if (reason !== "teardown") {
        const reasonText: string = reason === "timeout"
          ? "哼哼，处罚时间到啦"
          : "哼，提前解除啦";
        await sendCommandMessage({
          chatId: session.chatId,
          text: `${reasonText}，${session.targetLabel} 的 ${session.tool} 已经取下，` +
            "终于又能正常说话咯，可别高兴得太早呀，杂鱼♡",
          replyToMessageId,
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
export function activateGag(session: GagSession): void {
  session.expiresAt = Date.now() + session.durationMinutes * 60_000;
  session.phase = "active";
  session.timer = setTimeout(
    expireGag,
    session.durationMinutes * 60_000,
    session
  );
  session.timer.unref();
}

/** 开始提示发送失败；已发出的公开/临时提示仍必须沿同一收尾边界删除。 */
export async function failGagNotice(session: GagSession): Promise<void> {
  session.noticePending = false;
  const isCurrent: boolean =
    findGagSession(session.chatId, session.targetId) === session;
  if (
    session.publicNoticeMessageId === 0 &&
    session.ephemeralNoticeMessageId === 0
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
 * 开始提示 message id 的**同步**登记点，由发送层在拿到 id 的那一刻回调
 * （见 infra/telegram/actions/messages.ts 的 onSent）。
 *
 * 必须同步、且早于任何 await：停机时 `runner.abortActive()` 可能正落在「远端
 * 已经收下这条提示、handler 还没走到提交那一行」的窗口里，await 会以 AbortError
 * 解开，message id 随返回值一起蒸发——提示已经挂在群里，状态机却再也删不掉它，
 * 于是 gag owner 每次排空都判 failed，进程带着非零码退出。
 *
 * 幂等：正常路径上拿到发送返回值后会再调一次。
 */
export function recordGagPublicNotice(
  session: GagSession,
  noticeMessageId: number
): void {
  session.publicNoticeMessageId = noticeMessageId;
}

/** 普通用户专属开始入口的同步登记点；语义同 recordGagPublicNotice。 */
export function recordGagEphemeralNotice(
  session: GagSession,
  ephemeralMessageId: number
): void {
  session.ephemeralNoticeMessageId = ephemeralMessageId;
}

/**
 * 开始提示发送成功后的唯一提交点。teardown 若已把 starting 认领为 ending，
 * 就先写入迟到的 message id，再沿同一清理状态机删除，不能丢失 owner。
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

/** 群停管、机器人离群或降权时静默结束 gag，并重试遗留的 ending 提示。 */
export async function teardownGagInChat(chatId: number): Promise<void> {
  const sessions: GagSession[] | undefined = gagSessionsByChat.get(chatId);
  if (sessions === undefined) return;
  const snapshot: GagSession[] = [...sessions];
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
}

async function settleGagRuntime(): Promise<FlushResult> {
  if (gagBackgroundTasks.size > 0) {
    await Promise.allSettled([...gagBackgroundTasks]);
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
  return new Promise<FlushResult>((resolve: (result: FlushResult) => void): void => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(
      (): void => resolve("timedOut"),
      timeoutMs
    );
    void task.then((result: FlushResult): void => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

/** 清空 timer 与缓存；只供测试隔离，不执行 Telegram 动作。 */
export function resetGagSessions(): void {
  for (const sessions of gagSessionsByChat.values()) {
    for (const session of sessions) {
      if (session.timer !== null) clearTimeout(session.timer);
      if (session.cleanupTimer !== null) clearTimeout(session.cleanupTimer);
      session.timer = null;
      session.cleanupTimer = null;
    }
  }
  gagSessionsByChat.clear();
  gagBackgroundTasks.clear();
  gagRuntimeAccepting.current = true;
}

registerChatTeardown("gag", teardownGagInChat);
