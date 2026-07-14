import type { ChatPermissions } from "@grammyjs/types";

/**
 * 入群守卫在主线程侧的状态镜像（src/antiRaid.ts 代理）。
 * 权威状态（待验证记录、计数窗口、恢复计时器）全在 Worker 线程里
 * （cache/antiRaidWorker.ts）；这里只跟着 Worker 回报的 lockdown/unlock
 * 事件镜像「哪些群正处于私密模式」及各自的原始权限，用途是以 adopt 消息
 * 重放给 Worker 接管——Worker 崩溃重启后直接重放，进程重启则经
 * state.json 持久化中转（storage.ts 读写、initAntiRaid 加载）。
 * 权限限制已实际落在群上，不重放就永远无人解锁。
 */
export const lockedChats: Map<number, ChatPermissions> = new Map();
