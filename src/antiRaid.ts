import type { ChatPermissions } from "@grammyjs/types";
import { sendMessage, joinVerificationApi } from "./telegram";

/** 计数窗口时长：15 秒内入群人数若超过阈值，视为疑似拉人头刷群。 */
const JOIN_WINDOW_MS: number = 15 * 1000;
/** 15 秒窗口内触发私密模式的入群人数阈值。 */
const JOIN_THRESHOLD: number = 150;
/** 私密模式（禁止普通成员拉人）持续时长。 */
const LOCKDOWN_MS: number = 5 * 60 * 1000;

interface JoinWindow {
  count: number;
  resetTimeout: ReturnType<typeof setTimeout>;
}

interface Lockdown {
  /**
   * 触发私密模式前的原始默认权限，用于到期后精确恢复——而不是简单把
   * can_invite_users 设回 true，避免覆盖管理员本来就设置的其他限制。
   */
  originalPermissions: ChatPermissions;
  restoreTimeout: ReturnType<typeof setTimeout>;
}

// 均仅存于内存中，符合需求——计数窗口和私密模式状态都不需要在重启后保留。
const joinWindows: Map<number, JoinWindow> = new Map();
const activeLockdowns: Map<number, Lockdown> = new Map();

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
      console.error("Error triggering anti-raid lockdown:", error);
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
        console.error("Error restoring chat permissions after anti-raid lockdown:", error);
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
        console.error("Error restoring chat permissions after anti-raid lockdown:", error);
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

/** 私密模式到期后，恢复群组原本的默认权限。 */
async function restoreChat(chatId: number): Promise<void> {
  const lockdown = activeLockdowns.get(chatId);
  if (!lockdown) return;
  activeLockdowns.delete(chatId);

  await joinVerificationApi.setChatPermissions(chatId, lockdown.originalPermissions);
  await sendMessage(chatId, `5 分钟到啦，解除限制，普通成员又能拉人了，杂鱼们悠着点哦♡`, undefined, joinVerificationApi);
}
