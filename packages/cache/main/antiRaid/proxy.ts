import { ANTI_RAID_BARRIER_TIMEOUT_MS } from "../../../consts/antiRaid/protocol";
import { createFlushBarrier } from "../../../libs/flushBarrier";

/** Anti-Raid 主线程侧代理（packages/antiRaid/workerBridge.ts）的内存状态。 */

/**
 * Anti-Raid 主线程与 Worker 的 mailbox barrier。模块加载时创建，terminate
 * 时统一结算等待者；进程重启后以空等待表和新序号重建，容量受并发 flush 数约束。
 */
export const antiRaidBarrier: ReturnType<typeof createFlushBarrier> = createFlushBarrier({
  timeoutMs: ANTI_RAID_BARRIER_TIMEOUT_MS,
});

/**
 * Anti-Raid 主线程代理的代际与初始化状态。容量固定为一个对象，随进程生死；
 * Worker 重建时由 antiRaid/workerBridge.ts 递增 generation，不重置本对象。
 */
export const antiRaidRuntimeState: { generation: number; initialized: boolean; persistenceVersion: number } = {
  generation: 0,
  initialized: false,
  persistenceVersion: 0,
};
