import type { ChatPermissions, ChatFullInfo } from "grammy/types";
import type { LockdownDispatcher, LockdownEntry } from "../../types/antiRaid/internal";
import { deleteMessage, sendMessage, telegramApi } from "../../infra/telegram";
import { restoreLockdownInvitePermission } from "../../infra/telegram/lockdownPermissions";
import { INDEPENDENT_CHAT_PERMISSIONS_OTHER } from "../../consts/telegram";
import { lastLockdownIntentId, lockdownApiRunner, lockdownEntries } from "../../cache/workers/antiRaid/lockdown";
import { normalizeChatPermissions } from "../../libs/chatPermissions";
import { logger } from "../../infra/logger";
import { trackAntiRaidTask } from "./taskTracker";
import { lockdownAnnouncementText } from "./lockdownJoinWindow";

/** 在当前 Worker 内分配单调 intent；持久化与恢复约束见 docs/cn/04-invariants.md。 */
export function nextLockdownIntentId(): number {
  lastLockdownIntentId.current = Math.max(Date.now(), lastLockdownIntentId.current + 1);
  return lastLockdownIntentId.current;
}

/** 私密模式加锁/纠偏共用：在给定权限上关闭 can_invite_users，其余字段原样保留。 */
function restrictedPermissions(permissions: ChatPermissions): ChatPermissions {
  return { ...permissions, can_invite_users: false };
}

/**
 * 按群串行执行权限与公告操作，并登记到 Worker 生命周期。
 * 每项自行记录异常，失败不截断后续任务；串行与恢复约束见 docs/cn/04-invariants.md。
 */
function runLockdownApiCall(chatId: number, task: () => Promise<void>): void {
  void trackAntiRaidTask({ task: lockdownApiRunner.run(chatId, task) });
}

/**
 * 为当前占位发送公告，onSent 同步登记远端消息 ID，随后才处理发送返回或取消。
 * 结果只回投仍持有同一条目的状态；轮次已结束时沿串行链清理自身消息。
 * 发送与状态机清理边界见 docs/cn/04-invariants.md。
 */
export function beginLockdownAnnouncement(chatId: number, joinCount: number | undefined, dispatchLockdown: LockdownDispatcher): void {
  const entry: LockdownEntry | undefined = lockdownEntries.get(chatId);
  runLockdownApiCall(chatId, async (): Promise<void> => {
    if (entry === undefined || lockdownEntries.get(chatId) !== entry) return;
    let messageId: number | undefined;
    try {
      const sentMessageId: number | undefined = await sendMessage({
        chatId,
        text: lockdownAnnouncementText(joinCount),
        api: telegramApi,
        onSent: (pendingMessageId: number): void => {
          messageId = pendingMessageId;
        },
      });
      if (sentMessageId !== undefined) messageId = sentMessageId;
    } catch (error: unknown) {
      logger.error(`Error sending anti-raid lockdown announcement for chat ${chatId}:`, error);
    }
    if (lockdownEntries.get(chatId) !== entry) {
      if (messageId !== undefined) deleteLockdownAnnouncement(chatId, messageId);
      return;
    }
    dispatchLockdown(chatId, {
      type: "announcementResult",
      ok: messageId !== undefined,
      messageId,
    });
  });
}

/**
 * 沿群级串行链清理本轮公告；失败记录日志，不改变权限恢复状态。
 */
export function deleteLockdownAnnouncement(chatId: number, messageId: number): void {
  runLockdownApiCall(chatId, async (): Promise<void> => {
    try {
      await deleteMessage(chatId, messageId, telegramApi);
    } catch (error: unknown) {
      logger.error(
        `Error deleting the anti-raid lockdown announcement in chat ${chatId}:`,
        error
      );
    }
  });
}

/**
 * 读取当前权限，按本轮身份回投 applyPrepared；权限提交由 durable 回执触发。
 * preparing 占位阻止重复触发，取消或换轮后丢弃旧查询结果。
 */
export function prepareApplyLockdown(chatId: number, joinCount: number, dispatchLockdown: LockdownDispatcher): void {
  const entry: LockdownEntry | undefined = lockdownEntries.get(chatId);
  const isCurrent = (): boolean => entry !== undefined && lockdownEntries.get(chatId) === entry &&
    entry.state.kind === "applying" && entry.state.stage === "preparing";
  runLockdownApiCall(chatId, async (): Promise<void> => {
    if (!isCurrent()) return;
    try {
      const chat: ChatFullInfo = await telegramApi.getChat(chatId);
      if (!isCurrent()) return;
      if (!("permissions" in chat) || !chat.permissions) {
        // 恢复意图只接受带权限字段的群响应，缺失时撤销占位。
        logger.error(`Chat ${chatId} getChat response missing permissions field, skipping anti-raid lockdown`);
        dispatchLockdown(chatId, { type: "applyPreparationFailed" });
        return;
      }
      // 持久化副本只保留 schema 字段；权限提交仍重新读取 Telegram 当前完整值。
      const originalPermissions: ChatPermissions = normalizeChatPermissions(chat.permissions);
      dispatchLockdown(chatId, {
        type: "applyPrepared",
        originalPermissions,
        joinCount,
        intentId: nextLockdownIntentId(),
      });
    } catch (error: unknown) {
      logger.error("Error preparing anti-raid lockdown:", error);
      if (isCurrent()) dispatchLockdown(chatId, { type: "applyPreparationFailed" });
    }
  });
}

/**
 * applying intent 已落盘后才真正修改 Telegram。先重新读取最新权限，只合并
 * invite 限制，避免 T0 快照覆盖落盘窗口内的管理员修改。读取失败发生在写
 * 操作之前，可安全撤销 intent；set 失败的远端结果不确定，仍需恢复协调。
 */
export function commitApplyLockdown(chatId: number, dispatchLockdown: LockdownDispatcher): void {
  const entry: LockdownEntry | undefined = lockdownEntries.get(chatId);
  if (entry?.state.kind !== "applying" || entry.state.stage !== "prepared") return;
  const intentId: number = entry.state.intentId;
  const isCurrent = (): boolean => lockdownEntries.get(chatId) === entry &&
    entry.state.kind === "applying" && entry.state.stage === "prepared" && entry.state.intentId === intentId;
  runLockdownApiCall(chatId, async (): Promise<void> => {
    if (!isCurrent()) return;
    let currentPermissions: ChatPermissions;
    try {
      const chat: ChatFullInfo = await telegramApi.getChat(chatId);
      if (!isCurrent()) return;
      if (!("permissions" in chat) || !chat.permissions) {
        logger.error(
          `Chat ${chatId} commit getChat response missing permissions field, abandoning anti-raid lockdown`
        );
        dispatchLockdown(chatId, { type: "applyCommitPreparationFailed" });
        return;
      }
      currentPermissions = chat.permissions;
    } catch (error: unknown) {
      logger.error(
        "Error refreshing chat permissions before anti-raid lockdown; abandoning unapplied intent:",
        error
      );
      if (isCurrent()) dispatchLockdown(chatId, { type: "applyCommitPreparationFailed" });
      return;
    }
    try {
      await telegramApi.setChatPermissions(
        chatId,
        restrictedPermissions(currentPermissions),
        INDEPENDENT_CHAT_PERMISSIONS_OTHER
      );
      if (isCurrent()) dispatchLockdown(chatId, { type: "applyResult", ok: true });
    } catch (error: unknown) {
      logger.error("Error applying anti-raid lockdown; scheduling a restorative reconciliation:", error);
      if (isCurrent()) dispatchLockdown(chatId, { type: "applyResult", ok: false, restoreIntentId: nextLockdownIntentId() });
    }
  });
}

/** 异步恢复群组原本的默认权限，结果以 restoreResult 回投（失败由状态机安排重试）。 */
export function beginRestoreLockdown(chatId: number, originalPermissions: ChatPermissions, dispatchLockdown: LockdownDispatcher): void {
  runLockdownApiCall(chatId, async (): Promise<void> => {
    try {
      await restoreLockdownInvitePermission({
        chatId,
        originalPermissions,
        api: telegramApi,
      });
      dispatchLockdown(chatId, { type: "restoreResult", ok: true });
    } catch (error: unknown) {
      logger.error(`Failed to restore chat permissions for ${chatId}, retrying shortly:`, error);
      dispatchLockdown(chatId, { type: "restoreResult", ok: false });
    }
  });
}

/**
 * 当前 owner 仍处于 RECONCILING 时重新读取权限并关闭 invite，保留其它字段。
 * 成功或失败回投状态机，由其安排后续阶段与重试；顺序见 docs/cn/04-invariants.md。
 */
export function reapplyLockdownRestriction(chatId: number, dispatchLockdown: LockdownDispatcher): void {
  const entry: LockdownEntry | undefined = lockdownEntries.get(chatId);
  const isCurrent = (): boolean => entry !== undefined && lockdownEntries.get(chatId) === entry &&
    entry.state.kind === "reconciling";
  runLockdownApiCall(chatId, async (): Promise<void> => {
    if (!isCurrent()) return;
    try {
      const chat: ChatFullInfo = await telegramApi.getChat(chatId);
      if (!isCurrent()) return;
      if (!("permissions" in chat) || !chat.permissions) throw new Error("getChat response missing permissions");
      await telegramApi.setChatPermissions(
        chatId,
        restrictedPermissions(chat.permissions),
        INDEPENDENT_CHAT_PERMISSIONS_OTHER
      );
      if (isCurrent()) dispatchLockdown(chatId, { type: "reapplyResult", ok: true });
    } catch (error: unknown) {
      logger.error(`Error reapplying anti-raid restriction for chat ${chatId} after a stale restore succeeded; retrying shortly:`, error);
      if (isCurrent()) dispatchLockdown(chatId, { type: "reapplyResult", ok: false });
    }
  });
}
