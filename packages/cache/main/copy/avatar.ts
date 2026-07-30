import type { AvatarUpdateTask } from "../../../types/copy/avatar";

/** 头像更新队列（packages/copy/avatarQueue.ts）的内存状态。 */

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

/** 等待头像执行槽和 latest-only 槽归零的回调；完成或停机超时时结算清空。 */
export const avatarDrainWaiters: Set<() => void> = new Set();
/** 头像入口闸与统一 abort owner；init 重建 controller，quiesce/abort 时关闭。 */
export const avatarUpdateRuntime: { accepting: boolean; controller: AbortController } = {
  accepting: true,
  controller: new AbortController(),
};
