import { logger } from "./logger";
import { sendMessage, joinVerificationApi } from "./telegram";
import { JOIN_THRESHOLD, JOIN_WINDOW_MS, LOCKDOWN_MS, RESTORE_RETRY_MS } from "./consts/antiRaid";
import { activeLockdowns, joinWindows, type Lockdown } from "./cache/antiRaid";

/**
 * 记录一次已确认的新成员加入。由 joinVerification.ts 在去重后调用，因此同一次
 * 入群不会因 chat_member 更新和 new_chat_members 服务消息各触发一次而被重复计数。
 * 若 15 秒窗口内的入群人数超过阈值，则触发临时私密模式。
 */
export function recordJoin(chatId: number): void {
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
    existing.restoreTimeout = setTimeout(() => {
      void restoreChat(chatId).catch((error: unknown) => {
        logger.error("Error restoring chat permissions after anti-raid lockdown:", error);
      });
    }, LOCKDOWN_MS);
    return;
  }

  // 先同步占位再发起网络请求：recordJoin 对本函数是 fire-and-forget 调用，
  // 入群验证的主流程不会等它完成，因此同一波入群高峰里，getChat/setChatPermissions
  // 落地前可能已有好几次触发都跑到这里——若不先占位，它们都会看到"尚未加锁"，
  // 导致重复调用 API，且各自的 restoreTimeout 会互相覆盖，可能让锁定提前解除。
  const placeholder: Lockdown = {
    originalPermissions: {},
    restoreTimeout: setTimeout(() => {
      void restoreChat(chatId).catch((error: unknown) => {
        logger.error("Error restoring chat permissions after anti-raid lockdown:", error);
      });
    }, LOCKDOWN_MS),
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

  await sendMessage(
    chatId,
    `哼，15 秒内冲进来了 ${joinCount} 个杂鱼，本天才怀疑是有人在拉人头，先禁止普通成员邀请新人 5 分钟压压惊♡`,
    undefined,
    joinVerificationApi
  );
}

/**
 * 某个群聊当前是否处于反防刷群触发的私密模式（禁止普通成员拉人）。
 * 供 joinVerification.ts 判断：私密模式期间新加入的成员大概率也是这波刷群的
 * 一部分，应跳过质询流程直接踢出（但不封禁，以防误杀正常用户）。
 */
export function isLockedDown(chatId: number): boolean {
  return activeLockdowns.has(chatId);
}

/**
 * 私密模式到期后，恢复群组原本的默认权限。
 * 恢复调用成功之前绝不能把 lockdown 记录从 map 里删掉：否则一旦
 * setChatPermissions 失败（网络抖动、429 等），记录没了、无人重试，
 * 群的 can_invite_users 就永久卡在 false，只能等管理员发现后手动救。
 * 失败时保留记录并安排稍后重试；重试期间 isLockedDown 仍为 true，
 * 与「权限实际仍被限制着」的事实一致。
 */
async function restoreChat(chatId: number): Promise<void> {
  const lockdown = activeLockdowns.get(chatId);
  if (!lockdown) return;

  try {
    await joinVerificationApi.setChatPermissions(chatId, lockdown.originalPermissions);
  } catch (error: unknown) {
    logger.error(`Failed to restore chat permissions for ${chatId}, retrying in ${RESTORE_RETRY_MS / 1000}s:`, error);
    clearTimeout(lockdown.restoreTimeout);
    lockdown.restoreTimeout = setTimeout(() => {
      void restoreChat(chatId).catch((retryError: unknown) => {
        logger.error("Error restoring chat permissions after anti-raid lockdown:", retryError);
      });
    }, RESTORE_RETRY_MS);
    return;
  }

  activeLockdowns.delete(chatId);
  await sendMessage(chatId, `5 分钟到啦，解除限制，普通成员又能拉人了，杂鱼们悠着点哦♡`, undefined, joinVerificationApi);
}
