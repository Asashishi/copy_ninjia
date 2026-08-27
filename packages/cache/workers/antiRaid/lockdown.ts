import { createKeyedSerialTaskRunner } from "../../../libs/keyedSerialTaskRunner";
import type { KeyedSerialTaskRunner } from "../../../libs/keyedSerialTaskRunner";
import type { JoinWindow, LockdownEntry } from "../../../types/antiRaid/internal";

/**
 * 私密模式状态机（packages/workers/antiRaid/lockdownRuntime.ts）的内存状态；
 * verificationRuntime.ts 只读取 lockdownEntries 判断当前是否处于私密模式。
 */

/**
 * 每群最近入群滑窗；每条最多 JOIN_WINDOW_CAPACITY 个 number 和一个 timer。
 * 静默超时、群停用或 Worker 停止时清除；Worker 重建后为空并从下一次入群计数。
 */
export const joinWindows: Map<number, JoinWindow> = new Map();
/** 每群 lockdown 状态机与恢复 timer；解锁、停用或 Worker 停止时清除。 */
export const lockdownEntries: Map<number, LockdownEntry> = new Map();
/**
 * 每群「暂停再次触发私密模式」的绝对截止时刻（ms）。
 *
 * 状态机判定一轮作废时（读不到原权限、intent 落不了盘）发 suppressRetrigger，
 * lockdownRuntime.ts 的 beginLockdownRetriggerCooldown 据此写入；recordJoin 在
 * 到期前不再投递 thresholdExceeded。三处清理：到期后被下一次 recordJoin 就地
 * 删除、写入新条目时顺带扫掉所有已过期条目、群停用时按 chatId 删除（守卫都关
 * 了，重开不该背着旧冷却）；Worker 停止时随 stopLockdownRuntime 整体清空。
 * 条目只在作废路径产生，最多与机器人所在群数同阶。Worker 崩溃重建后为空 Map：
 * 无条目 = 不抑制触发，这是 fail-safe 方向（宁可多试一次也不漏防）。
 */
export const lockdownRetriggerCooldowns: Map<number, number> = new Map();
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
