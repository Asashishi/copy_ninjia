/**
 * Owner: perThread。主线程填入真实 Bot API 适配器，AI/Anti-Raid Worker 填入
 * 双工代理；各 isolate 独立持有，不共享引用。
 */

import type { TelegramApi } from "../../types/telegramWorker";

/**
 * 当前线程的 Telegram 能力实现。线程入口初始化时填充，进程或 Worker 退出时
 * 随 isolate 一并清理；容量恒为一个句柄，不需要淘汰或定时清扫。
 */
export const telegramApiState: { current: TelegramApi | null } = {
  current: null,
};
