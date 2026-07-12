import type { JoinWindow, Lockdown } from "../types";

/** 反刷群私密模式（src/antiRaid.ts）的内存状态。 */

// 均仅存于内存中，符合需求——计数窗口和私密模式状态都不需要在重启后保留。
export const joinWindows: Map<number, JoinWindow> = new Map();
export const activeLockdowns: Map<number, Lockdown> = new Map();
