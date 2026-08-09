/**
 * 刷屏禁言的执行侧（入群守卫线程）：一分钟内同一个人发言达到阈值，就地禁言
 * 几分钟并在群里说明一句。
 *
 * 主线程入口只做同步门禁 + 一次 post（见 packages/antiRaid/floodControl.ts），计数
 * 窗口与重试 owner 留在这里；Telegram 调用经双工请求回到主线程总闸，因此等待
 * 不阻塞本 Worker mailbox，也不会让原始 update handler 等待禁言网络往返。
 *
 * 与另外两条自动处置的边界：
 * - 反刷群私密模式数的是「多少人进来」，这里数的是「一个人说了多少」；
 * - 广告检测判的是「说了什么」，处置与 `/block` 同权且不可逆。
 * 刷屏禁言只是把人按下去几分钟，到点由 Telegram 按 `until_date` 自行恢复——
 * 本进程不排恢复计时器，因此它不写任何持久化状态、Worker 重建也不需要 adopt。
 */

import {
  deleteMessageAfter,
  muteChatMemberWithOutcome,
  sendMessage,
  joinVerificationApi,
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
import { TimestampDeque } from "../../libs/timestampDeque";
import { botCanRestrictIn } from "./botPermissions";
import { isChatAdmin } from "./adminCache";
import { antiRaidDispatchSignal, trackAntiRaidTask } from "./taskTracker";
import type { FloodCandidateMessage } from "../../types/antiRaid";
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
 * 命中时把整条窗口清空：既是去重（抑制窗口万一被回滚，也不会拿旧时间戳立刻
 * 再凑出一次命中），也是失败时的天然退避——这次没禁成的话，得再刷满一整个
 * 窗口才会重来，不会每来一条消息就重打一轮 API。导出仅为可测试性。
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
    // Date.now() 因系统校时短暂回退时仍保持队列单调，避免过期修剪失序。
    now = Math.max(now, entry.lastObservedAt);
    touchFloodWindow(entry);
  }
  entry.lastObservedAt = now;

  // 抑制期内到达的消息一律不计数：要么人已经被按住了（那几条是禁言落地前
  // 就在路上的），要么上一次判定的结论是确定性的，重判换不来新结果。
  if (now < entry.suppressedUntil) return undefined;

  entry.timestamps.trim(FLOOD_WINDOW_MS, now);
  entry.timestamps.push(now);
  if (entry.timestamps.size < FLOOD_MESSAGE_LIMIT) return undefined;
  entry.timestamps.clear();
  return entry;
}

/**
 * 群内通知文案：只说清「谁、因为什么、被按多久」。
 *
 * 不回显刷屏内容——那等于替他再刷一遍；也不点名请管理员介入——这次处置可逆，
 * 到点自己就解开了，和广告检测那条「人已经没了」的播报不是一回事。
 * 导出仅为可测试性。
 */
export function formatFloodMuteNotice(label: string): string {
  const minutes: number = Math.round(FLOOD_MUTE_DURATION_MS / 60_000);
  return `哼，${label} 一分钟刷了 ${FLOOD_MESSAGE_LIMIT} 条，本天才把你禁言 ${minutes} 分钟，` +
    "冷静完了再回来说话啦杂鱼♡";
}

interface MuteFlooderParams {
  message: FloodCandidateMessage;
  /** 触发这次处置的窗口条目，已由调用方置上乐观抑制位。 */
  entry: FloodWindowEntry;
}

/**
 * 把这次判定的乐观抑制位回滚掉，让下一个填满的窗口重试。
 *
 * 只在瞬时失败上调用（身份没查出来、禁言请求失败）。await 之后条目可能已被
 * LRU 淘汰或随 deactivateChat 清掉，按全线程惯例用「状态对象同一性」识别：
 * 对不上就说明这条窗口已经不属于这次判定了，不该再改它。
 */
function rollbackSuppression(chatId: number, userId: number, entry: FloodWindowEntry): void {
  if (getFloodWindowEntry(chatId, userId) !== entry) return;
  entry.suppressedUntil = 0;
}

/**
 * 禁言一名刷屏者并播报。
 *
 * 播报排在最后且只在禁言真的落地之后发：它断言的正是「人已经被按住了」，
 * 禁言没成还照发就是一条与事实相反的公告（同广告检测播报的理由）。
 *
 * **每个 await 之后都要复核这条窗口还在表里**（stillManaged）。停管、`/init disable`
 * 与群 teardown 都会走 deactivateChat → clearChatFloodWindows 把这个群的窗口全部
 * 丢掉，而机器人此刻多半仍是 Telegram 管理员：禁得动、也发得出话。对不上还照做，
 * 就是在一个本进程已经不再管理的群里把成员按住三分钟、再公开说一句「本天才把你
 * 禁言 3 分钟」——一次没人负责的处置，而本模块不排恢复计时器。同种情形下
 * adDetect/queue.ts（`pendingAdMessages.get(key) !== bundle`）与 verificationEffects.ts
 * 的 stillCurrent 都是就地中止。
 *
 * 代价是 FLOOD_WINDOW_MAX_MEMBERS 的 LRU 淘汰恰好撞在这次往返上时会少判一次
 * 刷屏，与那个常量 JSDoc 里写明的取舍完全一致（sweepFloodWindows 不会碰它：
 * 触发那一刻已置上乐观抑制位）。
 */
async function muteFlooder({ message, entry }: MuteFlooderParams): Promise<void> {
  const stillManaged = (): boolean =>
    getFloodWindowEntry(message.chatId, message.userId) === entry;
  // 停机已经开始：这次处置整个放掉，连身份确证那一次往返都不必付。禁言是尽力
  // 而为的（到点由 Telegram 自行解除，本进程不排恢复计时器、不落盘），而它命中
  // restrict 类 429 后的 retry_after 可以远超 drain 的预算——契约见 taskTracker 的
  // antiRaidDispatchSignal。
  const dispatchAbort: AbortSignal = antiRaidDispatchSignal();
  if (dispatchAbort.aborted) return;
  const targetIsAdmin: boolean | undefined = await isChatAdmin(message.chatId, message.userId, "flooding user");
  // 确认是管理员：结论是确定性的，保留抑制位——每填满一个窗口就重查一次身份
  // 既费额度又换不来别的答案。没查出来则是瞬时失败，回滚等下一个窗口。
  if (targetIsAdmin === undefined) rollbackSuppression(message.chatId, message.userId, entry);
  if (targetIsAdmin !== false) return;
  // 身份确证缓存冷时是一整次 getChatAdministrators，够管理员在这期间执行完
  // `/init disable`：这个群的窗口已经全被丢掉，别再往下处置（见函数头注）。
  if (!stillManaged()) return;

  // 截止时刻在真正发请求前算：上面那次身份确证可能等上几百毫秒（缓存冷时是
  // 一整次 getChatAdministrators），用收到消息那一刻的时钟会把时长抹短一截。
  const mutedUntil: number = Date.now() + FLOOD_MUTE_DURATION_MS;
  const outcome: MuteChatMemberOutcome = await muteChatMemberWithOutcome({
    chatId: message.chatId,
    userId: message.userId,
    mutedUntil,
    api: joinVerificationApi,
    // 两个取消源合起来：
    // - 超时：until_date 是这一刻算好的绝对时刻，请求命中 429 后还可能在 restrict 类退避车道排队。
    //   太久时它会在发出那一刻落进 Bot API 的「不足 30 秒即永久」区间——本模块
    //   不排恢复计时器，那就是一次只能人工解除的永久禁言。宁可放弃这次禁言：
    //   抑制位由下面的 failed 分支回滚，下一个满窗口重来。
    // - 停机：这个任务登记在 drain 的等待集合里，而上面那个超时是 2 分钟量级、
    //   drain 的预算是秒级。不撤掉的话，凡是停机恰好落在排队期间就换来一次脏
    //   退出加一批 update 重投（见 taskTracker 的 antiRaidDispatchSignal）。
    signal: AbortSignal.any([dispatchAbort, AbortSignal.timeout(FLOOD_MUTE_DISPATCH_TIMEOUT_MS)]),
  });
  if (outcome !== "muted") {
    // forbidden 是 Telegram 明确的拒绝（机器人缺权限，或目标其实是管理员而
    // 上面那份缓存刚好没认出来）：再试一次也一样，保留抑制位，别让一场刷屏
    // 每填满一个窗口就重打一个注定失败的请求。具体原因已由统一错误边界带着
    // Telegram 自己的说法记进日志，这里不再重复一行。failed 是限流/网络抖动，
    // 回滚等下一个满窗口——这也正是权限镜像还没到时那条兜底路径的收口。
    if (outcome === "failed") rollbackSuppression(message.chatId, message.userId, entry);
    return;
  }
  // 抑制位对齐到真实的禁言结束时刻：触发那一刻置的是乐观值，中间还隔着一次
  // 身份确证的往返。条目已被替换时不再回写，理由同 rollbackSuppression。
  // 只向后对齐、不把乐观值往回缩：mutedUntil 读的是原始墙钟，校时往回跳时它
  // 会比乐观值还早，直接赋值等于把抑制期提前作废（同 handleFloodCandidate）。
  if (stillManaged()) {
    entry.suppressedUntil = Math.max(entry.suppressedUntil, mutedUntil);
  }
  logger.log(
    `Flood control muted user ${message.userId} in chat ${message.chatId} for ` +
    `${Math.round(FLOOD_MUTE_DURATION_MS / 1000)}s after ${FLOOD_MESSAGE_LIMIT} messages in one minute.`
  );
  // 禁言请求本身也能排上一阵，停管可能正落在这期间。人是已经被按住了（这条
  // 事实收不回来，到点由 Telegram 自行解除），但不该再往一个已经不管的群里发言。
  if (!stillManaged()) return;

  const noticeMessageId: number | undefined = await sendMessage({
    chatId: message.chatId,
    text: formatFloodMuteNotice(message.label),
    api: joinVerificationApi,
    // 公告仍带派发截止时间：消息发送与踢人虽然已分属独立 429 队列，消息本身
    // 仍可能等待 grammY 的群聊限流。停管后再补发一条过期公告没有业务价值，也
    // 不该让它长期占住停机 drain（见 FLOOD_NOTICE_DISPATCH_TIMEOUT_MS）。
    // 停机信号一并接上：这条公告同样在 drain 的等待集合里。
    signal: AbortSignal.any([dispatchAbort, AbortSignal.timeout(FLOOD_NOTICE_DISPATCH_TIMEOUT_MS)]),
  });
  if (noticeMessageId === undefined) return;
  // 公告活到禁言解除那一刻为止：不给群里留永久公告（同踢人战报的约定），
  // 又不至于在人还被按着的时候就先撤掉、让后来的人看不懂他为什么不说话。
  // 统一延迟删除 owner 会在有序停机时提前兑现；batchOnFlush 让同群公告只占
  // 一次 deleteMessages 请求。硬崩溃仍会丢失纯内存 timer，这是明确取舍。
  deleteMessageAfter({
    chatId: message.chatId,
    messageId: noticeMessageId,
    delayMs: FLOOD_MUTE_DURATION_MS,
    api: joinVerificationApi,
    batchOnFlush: true,
  });
}

/**
 * 收下一条参与刷屏计数的群消息。同步记账，不阻塞 mailbox；越过阈值才派生一个
 * 后台任务去请求主线程网络能力，并登记进停机 drain 的在途集合。
 *
 * 权限闸排在最前面：**确证**没有「限制成员」权限时连身份确证那一次
 * `getChatAdministrators` 都不必付。权限位由主线程按变更镜像过来（见
 * ./botPermissions.ts），而它是三态——「没观测到」不当成没权限，照常往下走，
 * 由 Telegram 的回应当裁判，见 muteFlooder 对 `forbidden` / `failed` 的分档。
 */
export function handleFloodCandidate(message: FloodCandidateMessage, now: number = Date.now()): void {
  const entry: FloodWindowEntry | undefined =
    observeMemberMessage(message.chatId, message.userId, now);
  if (entry === undefined) return;
  // 乐观抑制：本函数是同步的 mailbox handler，一次爆发式刷屏能在第一次网络
  // 往返回来之前就把下一个窗口填满。等结果再置位就是同一个人挨两次禁言、
  // 群里挨两条公告。瞬时失败由 muteFlooder 自己回滚。
  //
  // 基准取 entry.lastObservedAt 而不是本函数的 now：observeMemberMessage 只把
  // **它自己的形参**钳到单调值（见那边的 Math.max），本函数的 now 还是原始墙钟。
  // 两边读不同的钟，系统校时往回跳一下就会写出一个「已经过期」的抑制位——消费侧
  // 拿钳过的时刻去比，`now < suppressedUntil` 恒假，这段乐观抑制等于没有。
  entry.suppressedUntil = entry.lastObservedAt + FLOOD_MUTE_DURATION_MS;

  // 三态：确证没有权限才就地放弃；「没观测到」照常往下走，由 Telegram 当裁判
  // ——镜像可能只是还没到（主线程的按需现查撞上一次 429 就会退避几分钟），
  // 那几分钟里把刷屏放过去、还在日志里写一句不准确的「没有权限」，比多打一个
  // 注定失败的请求糟得多。真没权限时那次请求会带回 Telegram 自己的说法。
  if (botCanRestrictIn(message.chatId) === false) {
    // 保留抑制位：这个结论在权限变回来之前不会变，而权限一变主线程会立刻
    // 镜像过来。不保留的话，一场刷屏就是每填满一个窗口往 logs/ 里刷同一行。
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
 * 删掉空闲满一个窗口的条目，挂在 Worker 的统一 sweep 节拍上。
 *
 * 只靠 LRU 是不够的：容量淘汰按写入顺序丢最早的那条，一个曾经热闹过、此刻
 * 早已安静的群会一直占着名额，把真正活跃的群挤出去。仍在抑制期的条目要留着
 * ——`suppressedUntil` 正是「这段时间到的消息不必再判」的依据，删掉就等于
 * 让抑制提前失效。
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
