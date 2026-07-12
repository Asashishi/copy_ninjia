import type { JoinWindow, Lockdown, PendingVerification } from "../types";

/**
 * 入群守卫流水线（src/workers/antiRaidWorker.ts）的内存状态。
 * 本模块只被 Worker 线程 import。均仅存于内存中，符合需求——待验证记录、
 * 计数窗口和私密模式状态都不需要在重启后保留。
 */

// 以 "chatId:userId" 为键，这样同一个人在不同群里会被独立追踪。
export const pendingVerifications: Map<string, PendingVerification> = new Map();
export const joinWindows: Map<number, JoinWindow> = new Map();
export const activeLockdowns: Map<number, Lockdown> = new Map();
