import type { AvatarUpdateTask } from "../../types/copy/avatar";

/** 全局头像资源：一个执行槽 + 一个 latest-only 待执行槽。 */
export const avatarUpdateState: {
  running: boolean;
  pending: AvatarUpdateTask | null;
  nextGeneration: number;
  latestGeneration: number;
} = {
  running: false,
  pending: null,
  nextGeneration: 1,
  latestGeneration: 0,
};

export const avatarDrainWaiters: Set<() => void> = new Set();
