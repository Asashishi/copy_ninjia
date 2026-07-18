import type { LockdownState } from "../../states/lockdown";
import type { JoinWindow } from "../../types/antiRaid/internal";

/** 一条私密模式状态机条目：纯状态 + 解释器持有的恢复计时器。 */
export interface LockdownEntry {
  state: LockdownState;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export const joinWindows: Map<number, JoinWindow> = new Map();
export const lockdownEntries: Map<number, LockdownEntry> = new Map();
/** 同一群的加锁、恢复和纠偏 API 调用共用的串行链。 */
export const lockdownApiChains: Map<number, Promise<void>> = new Map();

/** Worker dispose/测试隔离时清空私密模式运行时状态。 */
export function resetLockdownCache(): void {
  for (const window of joinWindows.values()) clearTimeout(window.resetTimeout);
  for (const entry of lockdownEntries.values()) {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
  }
  joinWindows.clear();
  lockdownEntries.clear();
  lockdownApiChains.clear();
}
