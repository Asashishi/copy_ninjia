import { gagRuntimeAccepting } from "../../cache/main/gag";
import { GAG_SPEAK_NOTICE_REFRESH_INTERVAL_MS } from "../../consts/gag";
import type { GagSession } from "../../types/gag";
import { deleteGagSpeakNotice, sendGagSpeakNotice } from "./notices";
import { findGagSession, trackGagBackgroundTask } from "./owner";

/** 发送与每个异步结算点都核对 owner、停机闸门与绝对到期时间。 */
function canRefreshGagSpeakNotice(session: GagSession): boolean {
  return gagRuntimeAccepting.current &&
    findGagSession(session.chatId, session.targetId) === session &&
    session.phase === "active" &&
    session.expiresAt > Date.now();
}

/** 撤销当前入口的定时换新；结束与停机边界见 docs/cn/04-invariants.md。 */
export function clearGagSpeakNoticeRefreshTimer(session: GagSession): void {
  if (session.speakNoticeRefreshTimer === null) return;
  clearTimeout(session.speakNoticeRefreshTimer);
  session.speakNoticeRefreshTimer = null;
}

/** 用户专属入口定时补发；与群消息换新共用单一在途任务及入口槽位。 */
function refreshGagSpeakNoticeFromTimer(session: GagSession): void {
  session.speakNoticeRefreshTimer = null;
  refreshGagSpeakNotice(session, session.speakNoticeThreadId);
}

/** 激活及换新结算后安装唯一 unref timer；频道公开入口只按消息数换新。 */
export function scheduleGagSpeakNoticeRefresh(session: GagSession): void {
  clearGagSpeakNoticeRefreshTimer(session);
  if (
    session.targetId <= 0 ||
    !canRefreshGagSpeakNotice(session) ||
    session.speakNoticeRefreshTask !== null ||
    session.expiresAt - Date.now() <= GAG_SPEAK_NOTICE_REFRESH_INTERVAL_MS
  ) return;
  session.speakNoticeRefreshTimer = setTimeout(
    refreshGagSpeakNoticeFromTimer,
    GAG_SPEAK_NOTICE_REFRESH_INTERVAL_MS,
    session
  );
  session.speakNoticeRefreshTimer.unref();
}

/** deleted/gone 都表示该入口不再可见，可以安全释放其唯一 id 槽位。 */
function gagNoticeDeletionFinished(
  outcome: Awaited<ReturnType<typeof deleteGagSpeakNotice>>
): boolean {
  return outcome === "deleted" || outcome === "gone";
}

/** 删除上一次换新遗留的旧入口；失败时保留固定单槽位，禁止继续堆新入口。 */
async function retryRetiredGagSpeakNotice(
  session: GagSession
): Promise<boolean> {
  const retiredId: number = session.retiredSpeakNoticeMessageId;
  if (retiredId === 0) return true;
  const outcome: Awaited<ReturnType<typeof deleteGagSpeakNotice>> =
    await deleteGagSpeakNotice(session, retiredId);
  const finished: boolean = gagNoticeDeletionFinished(outcome);
  if (
    finished &&
    session.retiredSpeakNoticeMessageId === retiredId
  ) session.retiredSpeakNoticeMessageId = 0;
  return finished;
}

/**
 * 发出本会话的新入口，再原子切换 current/pending/retired 三个固定槽位，最后
 * 删除旧入口。onSent 必须先写 pending：停机 abort 即使带走返回值，ending 仍
 * 能按精确目标身份回收远端已经建立的入口。
 *
 * `targetThreadId` 就是这条新入口要落进的话题：按消息数滚动换新时传当前话题
 * （原地换一条更靠下的），被管教的人换话题说话时传新话题（搬家）。两者是同一
 * 套「发新的 → 切槽位 → 删旧的」，因此不另写一条发送/删除路径。
 * `speakNoticeThreadId` 只在切槽位那一步更新，发送失败时仍指向旧话题，下一条
 * 消息还会再判一次要不要搬家。
 */
async function replaceGagSpeakNotice(
  session: GagSession,
  targetThreadId: number | undefined
): Promise<void> {
  if (!canRefreshGagSpeakNotice(session)) return;
  if (
    session.retiredSpeakNoticeMessageId !== 0 &&
    !await retryRetiredGagSpeakNotice(session)
  ) {
    session.messagesSinceSpeakNotice = 0;
    return;
  }
  if (!canRefreshGagSpeakNotice(session)) return;
  const recordPending = (noticeMessageId: number): void => {
    session.pendingSpeakNoticeMessageId = noticeMessageId;
  };
  const noticeMessageId: number | undefined = await sendGagSpeakNotice({
    session,
    messageThreadId: targetThreadId,
    onSent: recordPending,
  });
  if (noticeMessageId === undefined) {
    // API 失败由统一 Telegram 边界记录；下一轮消息阈值或定时换新再试。
    session.messagesSinceSpeakNotice = 0;
    return;
  }
  session.pendingSpeakNoticeMessageId = noticeMessageId;
  if (!canRefreshGagSpeakNotice(session)) return;
  const previousNoticeMessageId: number = session.speakNoticeMessageId;
  session.speakNoticeMessageId = noticeMessageId;
  session.speakNoticeThreadId = targetThreadId;
  session.pendingSpeakNoticeMessageId = 0;
  session.retiredSpeakNoticeMessageId =
    previousNoticeMessageId === noticeMessageId
      ? 0
      : previousNoticeMessageId;
  session.messagesSinceSpeakNotice = 0;
  if (session.retiredSpeakNoticeMessageId === 0) return;
  await retryRetiredGagSpeakNotice(session);
}

/**
 * 同一会话只允许一条换新任务；timer/teardown 可通过字段等待并接管所有 id。
 *
 * 已有任务在途时同步跳过，不登记等待者；它若发往旧话题，下一条目标消息会
 * 再次触发搬家。不同会话独立启动，出站并发和背压由统一 Telegram 边界管理。
 */
function refreshGagSpeakNotice(
  session: GagSession,
  targetThreadId: number | undefined
): void {
  if (session.speakNoticeRefreshTask !== null) return;
  if (!canRefreshGagSpeakNotice(session)) return;
  clearGagSpeakNoticeRefreshTimer(session);
  const task: Promise<void> = replaceGagSpeakNotice(session, targetThreadId).finally(
    (): void => {
      if (session.speakNoticeRefreshTask === task) {
        session.speakNoticeRefreshTask = null;
        scheduleGagSpeakNoticeRefresh(session);
      }
    }
  );
  session.speakNoticeRefreshTask = task;
  trackGagBackgroundTask(task, "Unexpected error while refreshing a gag speak notice:");
}

/**
 * 被管教的人在别的话题说话：把发言入口搬到那个话题，并删掉原话题里的旧入口。
 *
 * 与滚动换新共用 replaceGagSpeakNotice，因此 retired 槽位、单条在途任务与
 * ending 的接管语义全部沿用。旧入口重试也由同一个在途任务持有。
 */
export function moveGagSpeakNotice(
  session: GagSession,
  targetThreadId: number | undefined
): void {
  if (
    findGagSession(session.chatId, session.targetId) !== session ||
    session.phase !== "active" ||
    session.expiresAt <= Date.now() ||
    session.speakNoticeThreadId === targetThreadId
  ) return;
  refreshGagSpeakNotice(session, targetThreadId);
}

/** 为已命中阈值的会话同步认领各自任务；重复触发不登记等待者。 */
export function refreshDueGagSpeakNotices(
  due: readonly GagSession[]
): void {
  for (const session of due) {
    if (
      findGagSession(session.chatId, session.targetId) !== session ||
      session.phase !== "active" ||
      session.expiresAt <= Date.now()
    ) continue;
    // 滚动换新只是把入口挪到更靠下的位置，话题不变。
    refreshGagSpeakNotice(session, session.speakNoticeThreadId);
  }
}
