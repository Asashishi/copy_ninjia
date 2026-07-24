import { createKeyedSerialTaskRunner } from "../../libs/keyedSerialTaskRunner";
import type { KeyedSerialTaskRunner } from "../../libs/keyedSerialTaskRunner";
import type { JoinWindow } from "../../types/antiRaid/internal";
import type { LockdownState } from "../../types/states/lockdown";

/**
 * 私密模式状态机（src/workers/antiRaid/lockdownRuntime.ts）的内存状态；
 * verificationRuntime.ts 只读取 lockdownEntries 判断当前是否处于私密模式。
 */

/** 一条私密模式状态机条目：纯状态 + 解释器持有的恢复计时器。 */
export interface LockdownEntry {
  state: LockdownState;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** 每群最近入群滑窗；静默超时、群停用或 Worker 停止时清除。 */
export const joinWindows: Map<number, JoinWindow> = new Map();
/** 每群 lockdown 状态机与恢复 timer；解锁、停用或 Worker 停止时清除。 */
export const lockdownEntries: Map<number, LockdownEntry> = new Map();
/** 同一群的加锁、恢复和纠偏 API 调用共用的串行链。 */
export const lockdownApiChains: Map<number, Promise<void>> = new Map();
/**
 * 私密模式 Telegram API 的按群串行调度器，与 lockdownApiChains 共同存活；
 * Worker 重建后重新创建，空闲群的链由执行器自动删除。
 */
export const lockdownApiRunner: KeyedSerialTaskRunner<number> =
  createKeyedSerialTaskRunner(lockdownApiChains);

/**
 * 当前 Worker 最近分配的 lockdown intent ID。每次新意图单调提升；Worker
 * 重建时从 0 开始并以 Date.now() 抬高，不落盘恢复，容量固定为一个数字。
 */
export const lastLockdownIntentId: { current: number } = { current: 0 };
