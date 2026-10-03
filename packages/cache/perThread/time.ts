/** owner: perThread。默认时区与格式器只在各自 isolate 内持有，不共享可变内存。 */

import type { TimeZoneState } from "../../types/time";

/**
 * 主线程在 bot.json 严格校验后填充；AI、Anti-Raid 与 Disk I/O Worker 分别在 init、
 * agentConfig 与 load 消息中接管主线程的时区。主线程持有权威启动快照，Worker 重建时由
 * 主线程重放；不热重载。容量为一份时区状态，含一段可替换的 UTC 偏移区段（libs/time.ts
 * 未命中时就地改写，不跨线程同步），进程或 isolate 退出时释放。
 * null 表示尚未初始化，时间函数必须拒绝使用；线程边界见 docs/cn/04-invariants.md。
 */
export const timeZoneState: { current: TimeZoneState | null } = { current: null };
