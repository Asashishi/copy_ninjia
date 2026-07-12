import { logger } from "../infra/logger";
import { InlineKeyboard } from "grammy";
import {
  sendMessage,
  deleteMessage,
  deleteMessageAfter,
  kickChatMember,
  answerCallbackQuery,
  joinVerificationApi,
} from "../infra/telegram";
import { formatUserLabel } from "../users/userLabel";
import { KICK_NOTICE_AUTO_DELETE_MS } from "../consts/telegram";
import {
  JOIN_THRESHOLD,
  JOIN_WINDOW_MS,
  LOCKDOWN_KICK_DEDUPE_MS,
  LOCKDOWN_MS,
  RESTORE_RETRY_MS,
  VERIFICATION_BUTTON_TEXT,
  VERIFICATION_TIMEOUT_MS,
  VERIFY_CALLBACK_PREFIX,
  WELCOME_AUTO_DELETE_MS,
} from "../consts/antiRaid";
import { activeLockdowns, joinWindows, pendingVerifications } from "../cache/antiRaidWorker";
import type {
  AdoptableLockdown,
  AntiRaidMember,
  AntiRaidWorkerMessage,
  Lockdown,
  LockdownEvent,
  PendingVerification,
  UnlockEvent,
  VerifyCallbackMessage,
} from "../types";

/**
 * 入群守卫线程（Bun Worker）：入群验证 + 反刷群私密模式的合并流水线。
 * 主线程（src/auto/message.ts / index.ts → antiRaid.ts 代理）只做事件投递，所有
 * 状态与实际工作都在这里：验证窗口的建立/去重/超时踢人、验证按钮的应答、
 * 入群计数窗口、触发/延长私密模式、私密模式期间的删公告 + 踢人、到期
 * 恢复权限与失败重试。发往 Telegram 的调用不回主线程绕路——本线程
 * import telegram.ts 时会得到自己独立的 grammY Api 客户端（用带限流 +
 * 429 自动重试的 joinVerificationApi，突发的删/踢/发在这里排队，不占用
 * 主线程共享客户端）。error 日志经 logger.ts 的转发模式回传主线程统一落盘。
 *
 * 验证与反刷群共用状态，因此天然一致：recordJoin 触发私密模式的占位是
 * 同步落地的，同一批投递里越过阈值的那次入群，紧随其后的入群立刻就会
 * 走「直接踢出」分支，没有跨线程的镜像延迟。
 *
 * 私密模式的生效/解除以 lockdown/unlock 事件回报主线程——主线程据此维护
 * 一份镜像（cache/antiRaid.ts），在本线程崩溃重启后用 adopt 消息交还给
 * 新实例接管（待验证记录则随线程丢失：残留的验证按钮点了会得到「已失效」
 * 应答，重新进群即可）。
 */

declare var self: Worker;

function verificationKey(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}

function memberLabel(member: AntiRaidMember): string {
  return formatUserLabel({ id: member.id, username: member.username, first_name: member.first_name });
}

// —— 入群验证 ——

/**
 * 删除某个待验证成员被追踪的所有消息（如果有的话，包括入群公告、机器人的
 * 提醒消息，以及 TA 在等待期间发送的任何内容），将其踢出聊天，并发布一条通知
 * ——此时提到过 TA 的入群公告/提醒消息都已被删除，这条通知是关于谁被移除、
 * 为何被移除的唯一痕迹。在 1 分 30 秒窗口到期、仍未点击验证按钮时执行。
 */
async function expireVerification(chatId: number, userId: number): Promise<void> {
  const key: string = verificationKey(chatId, userId);
  const pending = pendingVerifications.get(key);
  if (!pending) return; // 已通过验证，或已经因为中途退群等原因被清理掉了
  pendingVerifications.delete(key);

  for (const messageId of pending.messageIds) {
    await deleteMessage(chatId, messageId, joinVerificationApi);
  }
  await kickChatMember(chatId, userId, joinVerificationApi);
  const noticeMessageId: number | undefined = await sendMessage(chatId, `啧，${pending.label} 磨磨蹭蹭 1分30秒 都点不出验证按钮，本天才把 TA 的痕迹清干净、顺手踢出去啦，杂鱼动作太慢咯♡`, undefined, joinVerificationApi);
  if (noticeMessageId !== undefined) {
    deleteMessageAfter(chatId, noticeMessageId, KICK_NOTICE_AUTO_DELETE_MS, joinVerificationApi);
  }
}

/**
 * 为新加入的成员启动（如果已在等待中则补充）一个验证窗口。设计上是幂等的：
 * `chat_member` 更新和 `new_chat_members` 服务消息（群组未隐藏入群消息时）
 * 可能针对同一次入群各自独立触发一次投递，后到达的那一次应该只是补充其
 * 消息 ID，而不是重启计时器/再发一次提醒。本函数是同步的：状态占位全部
 * 同步落地，网络请求一律 fire-and-forget——消息按 FIFO 逐条处理，同一波
 * 刷屏入群的后续投递不会被某一次踢人/发消息的网络往返卡住。
 * @param chatId 成员加入的聊天。
 * @param member 新加入的用户（id/username/first_name），主线程已过滤掉机器人。
 * @param announcementMessageId 若本次投递由 `new_chat_members` 服务消息触发，则为该消息的 ID（用于之后删除）。
 */
function ensureVerificationStarted(chatId: number, member: AntiRaidMember, announcementMessageId?: number): void {
  const key: string = verificationKey(chatId, member.id);
  const existing = pendingVerifications.get(key);
  if (existing) {
    if (announcementMessageId !== undefined) {
      if (existing.kicked) {
        // 这个人已经在私密模式下被直接踢出了，这条才姗姗来迟的入群公告/服务
        // 消息也顺手清理掉，不需要留着等占位记录自然过期。
        void deleteMessage(chatId, announcementMessageId, joinVerificationApi);
      } else {
        existing.messageIds.push(announcementMessageId);
      }
    }
    return;
  }

  // 反防刷群统计：只在真正新建待验证记录时计数一次，chat_member 更新和
  // new_chat_members 服务消息若针对同一次入群各自触发投递，不会被重复计数。
  // 越过阈值时 triggerLockdown 的占位是同步落地的（见其注释），所以紧接着
  // 的 activeLockdowns 判断对这一次入群本身就已生效。
  recordJoin(chatId);

  // 群聊当前处于反防刷群触发的私密模式：这波入群高峰大概率还在持续，新成员
  // 大概率也是刷量的一部分，跳过质询流程直接踢出（kickChatMember 只是踢出、
  // 不封禁，以防误杀正常用户，之后仍可正常申请加入）。
  if (activeLockdowns.has(chatId)) {
    // 占位记录：必须在任何网络请求之前同步插入，防止同一次入群的另一路
    // 投递因为查不到 existing 而重新 recordJoin/重新踢一次。
    pendingVerifications.set(key, {
      chatId,
      userId: member.id,
      label: memberLabel(member),
      messageIds: [],
      timeout: setTimeout(() => pendingVerifications.delete(key), LOCKDOWN_KICK_DEDUPE_MS),
      kicked: true,
    });

    void (async (): Promise<void> => {
      if (announcementMessageId !== undefined) {
        await deleteMessage(chatId, announcementMessageId, joinVerificationApi);
      }
      await kickChatMember(chatId, member.id, joinVerificationApi);
    })().catch((error: unknown) => {
      logger.error("Error kicking member during anti-raid lockdown:", error);
    });
    return;
  }

  const pending: PendingVerification = {
    chatId,
    userId: member.id,
    label: memberLabel(member),
    messageIds: announcementMessageId !== undefined ? [announcementMessageId] : [],
    timeout: setTimeout(() => {
      void expireVerification(chatId, member.id).catch((error: unknown) => {
        logger.error("Error expiring join verification:", error);
      });
    }, VERIFICATION_TIMEOUT_MS),
  };
  pendingVerifications.set(key, pending);

  // 提醒消息不等待发送完成：它经过限流的 joinVerificationApi，真实刷群
  // 场景下若在这里 await，同一波入群投递会逐个排队等发消息，可能导致
  // 15 秒的反防刷群计数窗口在真正数满阈值之前就先重置——刷群反而检测
  // 不到。发送结果异步回填 messageIds 即可，不影响后续到期清理。
  const reminderText: string =
    `喂，${memberLabel(member)}，新来的杂鱼给本天才听好了，` +
    `1分30秒内点下面的按钮证明你不是机器人，` +
    `不然本天才就把你的发言全部抹掉再一脚把你踢出去哦♡`;
  const verifyKeyboard: InlineKeyboard = new InlineKeyboard().text(VERIFICATION_BUTTON_TEXT, `${VERIFY_CALLBACK_PREFIX}${member.id}`);
  void sendMessage(chatId, reminderText, undefined, joinVerificationApi, verifyKeyboard)
    .then((reminderMessageId: number | undefined) => {
      if (reminderMessageId === undefined) return;
      if (pendingVerifications.get(key) === pending) {
        pending.messageIds.push(reminderMessageId);
        pending.reminderMessageId = reminderMessageId;
      } else {
        // 限流排队太久，提醒消息落地时验证已经结束了（过期清理/通过/中途离群）。
        // 无论哪种结局，这条迟到的提醒不删的话都会永远留在聊天里，所以直接删掉
        // （验证通过的场景下，带按钮的验证信息本来也是要删除的）。
        void deleteMessage(chatId, reminderMessageId, joinVerificationApi);
      }
    })
    .catch((error: unknown) => {
      logger.error("Error sending join verification reminder:", error);
    });
}

/** 取消一个待验证记录，但不处理消息——用于该成员已经离开的情况。 */
function cancelVerification(chatId: number, userId: number): void {
  const key: string = verificationKey(chatId, userId);
  const pending = pendingVerifications.get(key);
  if (pending) {
    clearTimeout(pending.timeout);
    pendingVerifications.delete(key);
  }
}

/** 追踪某个待验证成员发送的消息，以便验证超时被踢出时能把这些痕迹一并清理掉。 */
function trackPendingMessage(chatId: number, userId: number, messageId: number): void {
  const key: string = verificationKey(chatId, userId);
  const pending = pendingVerifications.get(key);
  // kicked 为 true 时这只是私密模式踢人后的去重占位，不是真的在等验证。
  if (!pending || pending.kicked) return;

  pending.messageIds.push(messageId);
}

/**
 * 处理入群验证按钮的点击。只有验证记录对应的那个新成员本人点击才算数——
 * 别人点了会得到一个提示气泡，不会帮 TA 通过验证，防止群友手滑帮僵尸端
 * 点开验证。验证通过后：删除带按钮的验证提醒消息，发一条欢迎消息并在
 * WELCOME_AUTO_DELETE_MS 后自动清理，不在聊天里留下长期痕迹。
 */
async function handleVerificationCallback(msg: VerifyCallbackMessage): Promise<void> {
  if (msg.chatId === undefined) {
    await answerCallbackQuery(msg.callbackQueryId, undefined, false, joinVerificationApi);
    return;
  }

  if (msg.from.id !== msg.targetUserId) {
    await answerCallbackQuery(msg.callbackQueryId, "这不是你的验证按钮哦，杂鱼别乱点～", true, joinVerificationApi);
    return;
  }

  const key: string = verificationKey(msg.chatId, msg.targetUserId);
  const pending = pendingVerifications.get(key);
  if (!pending || pending.kicked) {
    await answerCallbackQuery(msg.callbackQueryId, "验证已经失效啦，再试试重新进群吧", true, joinVerificationApi);
    return;
  }

  // 状态在任何 await 之前同步清掉：重复点击/并发点击的后到者会走上面的
  // 「已失效」分支，不会重复发欢迎消息。
  clearTimeout(pending.timeout);
  pendingVerifications.delete(key);
  await answerCallbackQuery(msg.callbackQueryId, "验证通过啦～", false, joinVerificationApi);
  if (pending.reminderMessageId !== undefined) {
    await deleteMessage(msg.chatId, pending.reminderMessageId, joinVerificationApi);
  }
  const welcomeMessageId: number | undefined = await sendMessage(msg.chatId, `哼，算你机灵，${memberLabel(msg.from)} 通过验证啦，欢迎杂鱼入群~♡`, undefined, joinVerificationApi);
  if (welcomeMessageId !== undefined) {
    deleteMessageAfter(msg.chatId, welcomeMessageId, WELCOME_AUTO_DELETE_MS, joinVerificationApi);
  }
}

// —— 反刷群私密模式 ——

/** 安排一次到期恢复（或失败重试），返回可被 clearTimeout 的计时器。 */
function scheduleRestore(chatId: number, delayMs: number): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    void restoreChat(chatId).catch((error: unknown) => {
      logger.error("Error restoring chat permissions after anti-raid lockdown:", error);
    });
  }, delayMs);
}

/**
 * 记录一次已确认的新成员加入（由 ensureVerificationStarted 在去重后调用）。
 * 若 15 秒窗口内的入群人数超过阈值，则触发临时私密模式。
 */
function recordJoin(chatId: number): void {
  let window = joinWindows.get(chatId);
  if (!window) {
    window = {
      count: 0,
      resetTimeout: setTimeout(() => joinWindows.delete(chatId), JOIN_WINDOW_MS),
    };
    joinWindows.set(chatId, window);
  }

  window.count += 1;
  if (window.count > JOIN_THRESHOLD) {
    void triggerLockdown(chatId, window.count).catch((error: unknown) => {
      logger.error("Error triggering anti-raid lockdown:", error);
    });
  }
}

/**
 * 禁止群内普通成员拉人（将默认权限中的 can_invite_users 设为 false），
 * LOCKDOWN_MS 后自动恢复原始权限。若群已处于私密模式（说明入群高峰仍在持续），
 * 则只延长恢复计时，不重复调用 setChatPermissions 或重复发通知。
 */
async function triggerLockdown(chatId: number, joinCount: number): Promise<void> {
  const existing = activeLockdowns.get(chatId);
  if (existing) {
    clearTimeout(existing.restoreTimeout);
    existing.restoreTimeout = scheduleRestore(chatId, LOCKDOWN_MS);
    return;
  }

  // 先同步占位再发起网络请求：recordJoin 对本函数是 fire-and-forget 调用，
  // 同一波入群高峰里，getChat/setChatPermissions 落地前可能已有好几次触发
  // 都跑到这里——若不先占位，它们都会看到"尚未加锁"，导致重复调用 API，
  // 且各自的 restoreTimeout 会互相覆盖，可能让锁定提前解除。同步占位还让
  // ensureVerificationStarted 里的 activeLockdowns 判断对同一批入群立即生效。
  const placeholder: Lockdown = {
    originalPermissions: {},
    restoreTimeout: scheduleRestore(chatId, LOCKDOWN_MS),
  };
  activeLockdowns.set(chatId, placeholder);

  try {
    const chat = await joinVerificationApi.getChat(chatId);
    placeholder.originalPermissions = ("permissions" in chat && chat.permissions) || {};
    await joinVerificationApi.setChatPermissions(chatId, { ...placeholder.originalPermissions, can_invite_users: false });
  } catch (error: unknown) {
    clearTimeout(placeholder.restoreTimeout);
    activeLockdowns.delete(chatId);
    throw error;
  }

  // 权限已实际落地，此刻才向主线程回报——镜像里只该出现真正生效了的私密
  // 模式，adopt 重放时「恢复原始权限」才不会把从未改过权限的群改坏。
  self.postMessage({ type: "lockdown", chatId, originalPermissions: placeholder.originalPermissions } satisfies LockdownEvent);

  await sendMessage(
    chatId,
    `哼，15 秒内冲进来了 ${joinCount} 个杂鱼，本天才怀疑是有人在拉人头，先禁止普通成员邀请新人 5 分钟压压惊♡`,
    undefined,
    joinVerificationApi
  );
}

/**
 * 私密模式到期后，恢复群组原本的默认权限。
 * 恢复调用成功之前绝不能把 lockdown 记录从 map 里删掉：否则一旦
 * setChatPermissions 失败（网络抖动、429 等），记录没了、无人重试，
 * 群的 can_invite_users 就永久卡在 false，只能等管理员发现后手动救。
 * 失败时保留记录并安排稍后重试；重试期间私密模式仍然生效（unlock 事件
 * 也尚未发出），与「权限实际仍被限制着」的事实一致。
 */
async function restoreChat(chatId: number): Promise<void> {
  const lockdown = activeLockdowns.get(chatId);
  if (!lockdown) return;

  try {
    await joinVerificationApi.setChatPermissions(chatId, lockdown.originalPermissions);
  } catch (error: unknown) {
    logger.error(`Failed to restore chat permissions for ${chatId}, retrying in ${RESTORE_RETRY_MS / 1000}s:`, error);
    clearTimeout(lockdown.restoreTimeout);
    lockdown.restoreTimeout = scheduleRestore(chatId, RESTORE_RETRY_MS);
    return;
  }

  activeLockdowns.delete(chatId);
  self.postMessage({ type: "unlock", chatId } satisfies UnlockEvent);
  await sendMessage(chatId, `5 分钟到啦，解除限制，普通成员又能拉人了，杂鱼们悠着点哦♡`, undefined, joinVerificationApi);
}

/**
 * 接管上一个（已崩溃的）Worker 留下的私密模式：内存状态随线程一起没了，
 * 但权限限制已实际落在群上，必须重新排恢复计时，否则永远无人解锁。
 * 计时从满额 LOCKDOWN_MS 重新起算——崩溃前已过去多久无从得知，宁可多锁
 * 一会儿也不能不解锁。
 */
function adoptLockdowns(lockdowns: AdoptableLockdown[]): void {
  for (const { chatId, originalPermissions } of lockdowns) {
    if (activeLockdowns.has(chatId)) continue;
    activeLockdowns.set(chatId, {
      originalPermissions,
      restoreTimeout: scheduleRestore(chatId, LOCKDOWN_MS),
    });
  }
}

self.onmessage = (event: MessageEvent<AntiRaidWorkerMessage>) => {
  const msg: AntiRaidWorkerMessage = event.data;
  switch (msg.type) {
    case "join":
      ensureVerificationStarted(msg.chatId, msg.member, msg.announcementMessageId);
      break;
    case "left":
      cancelVerification(msg.chatId, msg.userId);
      break;
    case "message":
      trackPendingMessage(msg.chatId, msg.userId, msg.messageId);
      break;
    case "callback":
      void handleVerificationCallback(msg).catch((error: unknown) => {
        logger.error("Error handling join verification callback:", error);
      });
      break;
    case "adopt":
      adoptLockdowns(msg.lockdowns);
      break;
  }
};
