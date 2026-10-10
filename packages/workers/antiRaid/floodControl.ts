import type { AtmosphereTexts } from "../../types/atmosphere";
import { workerAtmosphere } from "./atmosphere";
import { sendTemporaryMessageFromMain } from "../../infra/telegram/workerClient";
/**
 * 刷屏禁言的执行侧（入群守卫线程）：窗口（FLOOD_WINDOW_MS）内同一个人发言达到阈值
 * （FLOOD_MESSAGE_LIMIT），就地禁言 FLOOD_MUTE_DURATION_MS 并在群里说明一句。
 *
 * 主线程入口只做同步门禁 + 一次 post（见 packages/antiRaid/floodControl.ts），计数
 * 窗口与重试 owner 留在这里；Telegram 调用经双工请求回到主线程总闸，等待
 * 不阻塞本 Worker mailbox。
 *
 * 与另外两条自动处置的边界：
 * - 反刷群私密模式数的是「多少人进来」，这里数的是「一个人说了多少」；
 * - 广告检测判的是「说了什么」，处置与 `/block` 同权且不可逆。
 * 刷屏禁言到点由 Telegram 按 `until_date` 自行恢复，本进程不排恢复计时器、
 * 不写持久化状态，Worker 重建不需要 adopt。
 */

import {
  muteChatMemberWithOutcome,
  telegramApi,
} from "../../infra/telegram";
import { logger } from "../../infra/logger";
import {
  FLOOD_MESSAGE_LIMIT,
  FLOOD_MUTE_DISPATCH_TIMEOUT_MS,
  FLOOD_MUTE_DURATION_MS,
  FLOOD_NOTICE_DISPATCH_TIMEOUT_MS,
  FLOOD_WINDOW_MAX_MEMBERS,
  FLOOD_WINDOW_MS,
} from "../../consts/antiRaid/flood";
import {
  floodWindowCacheStateHolder,
  floodWindowsByChat,
} from "../../cache/workers/antiRaid/flood";
import { signalWithTimeout } from "../../libs/abortSignal";
import { TimestampDeque } from "../../libs/timestampDeque";
import { sanitizeDisplayName } from "../../libs/text";
import { botCanRestrictIn } from "./botPermissions";
import { isChatAdmin } from "./adminCache";
import { antiRaidDispatchSignal } from "../../cache/workers/antiRaid/tasks";
import { trackAntiRaidTask } from "./taskTracker";
import type { FloodCandidateMessage } from
  "../../types/antiRaid/protocol";
import type {
  FloodWindowCacheState,
  FloodWindowEntry,
} from "../../types/antiRaid/internal";
import type { MuteChatMemberOutcome } from "../../infra/telegram";

/** 按两层数值索引读取条目；热路径不构造复合字符串。 */
function getFloodWindowEntry(chatId: number, userId: number): FloodWindowEntry | undefined {
  return floodWindowsByChat.get(chatId)?.get(userId);
}

/** 从 LRU 链摘下仍在链中的条目，不触碰分层索引与容量。 */
function unlinkFloodWindow(entry: FloodWindowEntry): void {
  const state: FloodWindowCacheState = floodWindowCacheStateHolder.current;
  const newer: FloodWindowEntry | null = entry.lruNewer;
  const older: FloodWindowEntry | null = entry.lruOlder;
  if (newer === null) state.newest = older;
  else newer.lruOlder = older;
  if (older === null) state.oldest = newer;
  else older.lruNewer = newer;
  entry.lruNewer = null;
  entry.lruOlder = null;
}

/** 把已摘链条目放到 LRU 最新端；只改固定 shape 字段，不重排 Map。 */
function linkFloodWindowAsNewest(entry: FloodWindowEntry): void {
  const state: FloodWindowCacheState = floodWindowCacheStateHolder.current;
  const previousNewest: FloodWindowEntry | null = state.newest;
  entry.lruNewer = null;
  entry.lruOlder = previousNewest;
  if (previousNewest === null) state.oldest = entry;
  else previousNewest.lruNewer = entry;
  state.newest = entry;
}

/** 热命中原地刷新 LRU；已经是最新时不做无效指针写入。 */
function touchFloodWindow(entry: FloodWindowEntry): void {
  if (floodWindowCacheStateHolder.current.newest === entry) return;
  unlinkFloodWindow(entry);
  linkFloodWindowAsNewest(entry);
}

/** 从索引和 LRU 同时删除同一对象；异步旧引用无法误删后来复建的条目。 */
function removeFloodWindow(entry: FloodWindowEntry): void {
  const members: Map<number, FloodWindowEntry> | undefined = floodWindowsByChat.get(entry.chatId);
  if (members?.get(entry.userId) !== entry) return;
  members.delete(entry.userId);
  if (members.size === 0) floodWindowsByChat.delete(entry.chatId);
  unlinkFloodWindow(entry);
  floodWindowCacheStateHolder.current.entryCount--;
}

/**
 * 记一条发言，并判断这条是不是压垮窗口的那一条。
 *
 * 命中时清空该成员的整条窗口：抑制位被回滚后也不会拿旧时间戳再次命中，
 * 下一次命中需要重新填满窗口。导出仅为可测试性。
 * @param now 当前时刻；默认取墙钟，测试注入固定值。
 * @returns 命中时返回该成员的窗口条目，供调用方就地置抑制位；否则 undefined。
 */
export function observeMemberMessage(
  chatId: number,
  userId: number,
  now: number = Date.now()
): FloodWindowEntry | undefined {
  let entry: FloodWindowEntry | undefined = getFloodWindowEntry(chatId, userId);
  if (entry === undefined) {
    const state: FloodWindowCacheState = floodWindowCacheStateHolder.current;
    if (state.entryCount >= FLOOD_WINDOW_MAX_MEMBERS && state.oldest !== null) {
      removeFloodWindow(state.oldest);
    }
    let members: Map<number, FloodWindowEntry> | undefined = floodWindowsByChat.get(chatId);
    if (members === undefined) {
      members = new Map<number, FloodWindowEntry>();
      floodWindowsByChat.set(chatId, members);
    }
    entry = {
      chatId,
      userId,
      timestamps: new TimestampDeque(FLOOD_MESSAGE_LIMIT),
      lastObservedAt: now,
      suppressedUntil: 0,
      lruNewer: null,
      lruOlder: null,
    };
    members.set(userId, entry);
    state.entryCount++;
    linkFloodWindowAsNewest(entry);
  } else {
    // Date.now() 因系统校时回退时仍保持队列单调。
    now = Math.max(now, entry.lastObservedAt);
    touchFloodWindow(entry);
  }
  entry.lastObservedAt = now;

  // 抑制期内到达的消息一律不计数。
  if (now < entry.suppressedUntil) return undefined;

  entry.timestamps.trim(FLOOD_WINDOW_MS, now);
  entry.timestamps.push(now);
  if (entry.timestamps.size < FLOOD_MESSAGE_LIMIT) return undefined;
  entry.timestamps.clear();
  return entry;
}

/**
 * 群内通知文案：包含被禁言者、刷屏阈值与禁言时长，不回显刷屏内容，不点名管理员。
 * 导出仅为可测试性。
 */
export function formatFloodMuteNotice(label: string, atmosphere: AtmosphereTexts): string {
  const minutes: number = Math.round(FLOOD_MUTE_DURATION_MS / 60_000);
  return atmosphere.NOTICE_TEXTS.floodMuted(label, FLOOD_MESSAGE_LIMIT, minutes);
}

interface MuteFlooderParams {
  message: FloodCandidateMessage;
  /** 触发这次处置的窗口条目，已由调用方置上乐观抑制位。 */
  entry: FloodWindowEntry;
}

/**
 * 把这次判定的乐观抑制位回滚，让下一个填满的窗口重试。
 *
 * 只在瞬时失败上调用（身份没查出来、禁言请求失败）。条目已被 LRU 淘汰或随
 * deactivateChat 清掉时，按「状态对象同一性」识别，对不上就不再改它。
 */
function rollbackSuppression(chatId: number, userId: number, entry: FloodWindowEntry): void {
  if (getFloodWindowEntry(chatId, userId) !== entry) return;
  entry.suppressedUntil = 0;
}

/**
 * 禁言一名刷屏者并播报。
 *
 * 播报排在最后，只在禁言落地之后发。
 *
 * **每个 await 之后复核这条窗口仍在表里**（stillManaged）：停管、`/init disable`
 * 与群 teardown 经 deactivateChat → clearChatFloodWindows 丢掉该群的窗口，对不上时
 * 就地中止，不再禁言或播报。同种情形下 adDetect/verdict.ts
 * （`pendingAdBundle(bundle.chatId, bundle.senderId) !== bundle`）与
 * verificationEffects/terminal.ts 的 stillCurrent 同样就地中止。
 *
 * FLOOD_WINDOW_MAX_MEMBERS 的 LRU 淘汰撞在这次往返上时，该次处置按 stillManaged 放弃；
 * sweepFloodWindows 不会碰它：触发时已置上乐观抑制位。
 */
async function muteFlooder({ message, entry }: MuteFlooderParams): Promise<void> {
  const stillManaged = (): boolean =>
    getFloodWindowEntry(message.chatId, message.userId) === entry;
  // 停机已经开始：整个处置放掉，不做身份确证。禁言是尽力而为的，契约见
  // cache/workers/antiRaid/tasks.ts 的 antiRaidDispatchSignal。
  const dispatchAbort: AbortSignal = antiRaidDispatchSignal();
  if (dispatchAbort.aborted) return;
  const targetIsAdmin: boolean | undefined = await isChatAdmin(message.chatId, message.userId, "flooding user");
  // 确认是管理员时保留抑制位；没查出来是瞬时失败，回滚等下一个窗口。
  if (targetIsAdmin === undefined) rollbackSuppression(message.chatId, message.userId, entry);
  if (targetIsAdmin !== false) return;
  // 身份确证期间窗口可能已被 deactivateChat 清掉，此时不再往下处置（见函数头注）。
  if (!stillManaged()) return;

  // 截止时刻在身份确证之后、发请求前计算，禁言时长从此刻起算。
  const mutedUntil: number = Date.now() + FLOOD_MUTE_DURATION_MS;
  const outcome: MuteChatMemberOutcome = await muteChatMemberWithOutcome({
    chatId: message.chatId,
    userId: message.userId,
    mutedUntil,
    api: telegramApi,
    // 两个取消源由 muteChatMemberWithOutcome 合并：
    // - 派发截止（FLOOD_MUTE_DISPATCH_TIMEOUT_MS）：until_date 是此刻算好的绝对时刻，
    //   超过截止的请求放弃发出，抑制位由下面的 failed 分支回滚，下一个满窗口重来。
    // - 停机：任务登记在 drain 的等待集合里，停机时撤销排队中的请求（见
    //   cache/workers/antiRaid/tasks.ts 的 antiRaidDispatchSignal）。
    dispatchTimeoutMs: FLOOD_MUTE_DISPATCH_TIMEOUT_MS,
    signal: dispatchAbort,
  });
  if (outcome !== "muted") {
    // forbidden 是 Telegram 明确的拒绝（机器人缺权限，或目标是管理员而缓存未认出）：
    // 保留抑制位，原因已由统一错误边界记入日志。failed 是限流/网络抖动，
    // 回滚等下一个满窗口。
    if (outcome === "failed") rollbackSuppression(message.chatId, message.userId, entry);
    return;
  }
  // 抑制位对齐到真实的禁言结束时刻，只向后取大、不缩短乐观值（同 handleFloodCandidate）；
  // 条目已被替换时不再回写，同 rollbackSuppression。
  if (stillManaged()) {
    entry.suppressedUntil = Math.max(entry.suppressedUntil, mutedUntil);
  }
  logger.log(
    `Flood control muted user ${message.userId} in chat ${message.chatId} for ` +
    `${Math.round(FLOOD_MUTE_DURATION_MS / 1000)}s after ${FLOOD_MESSAGE_LIMIT} messages in one minute.`
  );
  // 禁言请求期间群可能已停管；已停管时不再发言。
  if (!stillManaged()) return;

  await sendTemporaryMessageFromMain({
    purpose: "notice",
    chatId: message.chatId,
    text: floodMuteNoticeText(message.name, workerAtmosphere()),
    signal: signalWithTimeout(dispatchAbort, FLOOD_NOTICE_DISPATCH_TIMEOUT_MS),
  });
}

/**
 * 禁言通知正文：展示名原文经 sanitizeDisplayName 清洗，空时退化为本进程风格的 unknownUser，
 * 与 users/userLabel.ts 的 formatUserLabel 对同一身份的结果逐字一致。昵称是用户可控内容，
 * 刷屏公告不设 parse_mode（见 docs/cn/04-invariants.md）。
 */
function floodMuteNoticeText(name: string, atmosphere: AtmosphereTexts): string {
  return formatFloodMuteNotice(sanitizeDisplayName(name) || atmosphere.NOTICE_TEXTS.unknownUser, atmosphere);
}

/**
 * 收下一条参与刷屏计数的群消息。同步记账，不阻塞 mailbox；越过阈值才派生一个
 * 后台任务去请求主线程网络能力，并登记进停机 drain 的在途集合。
 *
 * 权限闸排在最前面：**确证**没有「限制成员」权限时不做身份确证、不发请求。
 * 权限位由主线程按变更镜像过来（见 ./botPermissions.ts），是三态——「没观测到」
 * 不当成没权限，照常往下走，由 Telegram 的回应判定，见 muteFlooder 对
 * `forbidden` / `failed` 的分档。
 *
 * 计数时刻取候选自带的主线程观测时刻（见 FloodCandidateMessage.observedAt）；
 * 本线程不为每条候选另读一次墙钟。
 */
export function handleFloodCandidate(message: FloodCandidateMessage): void {
  const entry: FloodWindowEntry | undefined =
    observeMemberMessage(message.chatId, message.userId, message.observedAt);
  if (entry === undefined) return;
  // 乐观抑制：先置抑制位再派生任务，瞬时失败由 muteFlooder 回滚。
  //
  // 基准取 entry.lastObservedAt 而非 message.observedAt：observeMemberMessage 已把时刻
  // 钳到单调值（见那边的 Math.max），消费侧用同一个钟比较 suppressedUntil。
  entry.suppressedUntil = entry.lastObservedAt + FLOOD_MUTE_DURATION_MS;

  // 三态：确证没有权限才就地放弃；「没观测到」照常往下走，由 Telegram 的回应判定。
  if (botCanRestrictIn(message.chatId) === false) {
    // 保留抑制位，权限变更由主线程镜像过来。
    logger.error(
      `Flood control cannot mute user ${message.userId} in chat ${message.chatId}: ` +
      "the bot does not have permission to restrict members."
    );
    return;
  }
  void trackAntiRaidTask({
    task: muteFlooder({ message, entry }).catch((error: unknown): void => {
      rollbackSuppression(message.chatId, message.userId, entry);
      logger.error(`Failed to mute flooding user ${message.userId} in chat ${message.chatId}:`, error);
    }),
  });
}

/** 停管/`/init disable`/群 teardown：丢掉这个群全部成员的发言窗口。 */
export function clearChatFloodWindows(chatId: number): void {
  const members: Map<number, FloodWindowEntry> | undefined = floodWindowsByChat.get(chatId);
  if (members === undefined) return;
  for (const entry of members.values()) unlinkFloodWindow(entry);
  floodWindowCacheStateHolder.current.entryCount -= members.size;
  floodWindowsByChat.delete(chatId);
}

/**
 * 删掉空闲满一个窗口（FLOOD_WINDOW_MS）的条目，挂在 Worker 的统一 sweep 节拍上；
 * 仍在抑制期（`suppressedUntil`）的条目保留。
 * @returns 本次删除的条目数，便于测试与诊断。
 */
export function sweepFloodWindows(now: number = Date.now()): number {
  let deleted: number = 0;
  for (const members of floodWindowsByChat.values()) {
    for (const entry of members.values()) {
      if (now < entry.suppressedUntil) continue;
      if (now - entry.lastObservedAt <= FLOOD_WINDOW_MS) continue;
      removeFloodWindow(entry);
      deleted++;
    }
  }
  return deleted;
}

/** Worker stop/测试隔离时清空窗口表；生产停机由 isolate 回收。 */
export function resetFloodWindows(): void {
  for (const members of floodWindowsByChat.values()) {
    for (const entry of members.values()) {
      entry.lruNewer = null;
      entry.lruOlder = null;
    }
  }
  floodWindowsByChat.clear();
  const state: FloodWindowCacheState = floodWindowCacheStateHolder.current;
  state.entryCount = 0;
  state.newest = null;
  state.oldest = null;
}
