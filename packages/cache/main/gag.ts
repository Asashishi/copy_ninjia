import type { GagSession } from "../../types/gag";

/** 主线程 command/gag 的运行时状态；Worker 不得 import。 */

/**
 * 主线程权威 gag 表：chatId 定位小型目标列表，同群可同时管教多个身份，
 * 但同群同 targetId 至多一条。`/gag` 在发开始提示前以 starting 预约，
 * 公开状态与目标入口全部成功后切 active 并安装 unref timer；每条入口各自按
 * 群消息数滚动换新，current/pending/retired 三个固定 id 槽位关闭换新与结束的
 * 竞态且不会随失败次数增长。超时、`/ungag` 或群 teardown 同步认领为 ending，
 * 只有全部提示确实 deleted/gone 后才按对象身份删除；瞬时失败
 * 保留有界重试与 owner。全局容量由 gag command 常量约束，不淘汰有效会话。
 * 它不落盘：Worker 重建不影响此主线程权威表；正常进程停机由 gag drain 在
 * Telegram 总闸关闭前清理，非正常进程终止才会直接丢失内存状态。
 */
export const gagSessionsByChat: Map<number, GagSession[]> = new Map();

/**
 * gag owner 是否接受新预约。应用初始化时置真，停机先置假；已有会话仍由 drain
 * 清理。容量恒为一个布尔值，进程重启后由应用生命周期重新初始化。
 */
export const gagRuntimeAccepting: { current: boolean } = { current: true };

/**
 * timeout/清理重试派生的后台任务。任务结算后立即自删；每条会话最多一个 ending
 * task，全局受 GAG_SESSION_MAX 间接约束，停机 drain 会等待当前快照。
 */
export const gagBackgroundTasks: Set<Promise<void>> = new Set();

/** 统计 starting、active 与 ending 的全部占位；用于原子预约全局容量。 */
export function gagSessionCount(): number {
  let count: number = 0;
  for (const sessions of gagSessionsByChat.values()) count += sessions.length;
  return count;
}

/** 统计真正正在拦截消息的 active 目标；用于 `/bot_status` 展示。 */
export function activeGagSessionCount(): number {
  let count: number = 0;
  for (const sessions of gagSessionsByChat.values()) {
    for (const session of sessions) {
      if (session.phase === "active") count++;
    }
  }
  return count;
}
