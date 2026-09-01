import type { ChatPermissions } from "grammy/types";
import { lockdownEntries } from "../../cache/workers/antiRaid/lockdown";
import type { LockdownEvent } from "../../types/antiRaid/events";
import type { LockdownEntry } from "../../types/antiRaid/internal";
import type { LockdownState } from "../../types/states/lockdown";

declare const self: Worker;

/** 把当前私密模式状态投影成主线程持久化事件。 */
export function publishLockdownState(chatId: number): void {
  const entry: LockdownEntry | undefined = lockdownEntries.get(chatId);
  if (entry === undefined) return;
  const state: LockdownState = entry.state;
  const announced: boolean = state.announced;
  const announcementMessageId: number | undefined = state.announcementMessageId;
  let intentId: number;
  let originalPermissions: ChatPermissions;
  let expiresAt: number;
  if (state.kind === "applying") {
    if (state.stage !== "prepared") return;
    intentId = state.intentId;
    originalPermissions = state.originalPermissions;
    expiresAt = Date.now();
  } else {
    intentId = state.intentId;
    originalPermissions = state.originalPermissions;
    if (state.kind === "active" || state.kind === "reconciling") {
      if (entry.restoreAt === undefined) {
        throw new Error(
          `Lockdown ${state.kind} state for chat ${chatId} is missing its restore deadline.`
        );
      }
      expiresAt = entry.restoreAt;
    } else {
      expiresAt = Date.now();
    }
  }
  self.postMessage({
    type: "lockdown",
    chatId,
    phase: state.kind,
    intentId,
    originalPermissions,
    announced,
    announcementMessageId,
    expiresAt,
  } satisfies LockdownEvent);
}
