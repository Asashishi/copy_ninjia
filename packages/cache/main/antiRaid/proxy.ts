/** owner: main。Anti-Raid 主线程侧代理（packages/antiRaid/workerBridge/）的内存状态。 */

import { ANTI_RAID_BARRIER_TIMEOUT_MS } from "../../../consts/antiRaid/protocol";
import { createFlushBarrier } from "../../../libs/flushBarrier";

/**
 * Anti-Raid 主线程与 Worker 的 mailbox barrier。模块加载时创建，terminate
 * 时统一结算等待者；进程重启后以空等待表和新序号重建，容量受并发 flush 数约束。
 */
export const antiRaidBarrier: ReturnType<typeof createFlushBarrier> = createFlushBarrier({
  timeoutMs: ANTI_RAID_BARRIER_TIMEOUT_MS,
});

/**
 * Anti-Raid 主线程代理的代际与初始化状态。容量固定为一个对象，随进程生死；
 * Worker 重建时由 antiRaid/workerBridge/controller.ts 递增 generation，不重置本对象。
 * 镜像版本号分别在待验证镜像（`verification` 领域）与 lockdown 记录（`chatState`
 * 领域）变化时递增，durable 投递据此只刷变化过的领域；initAntiRaid 归零。
 */
export const antiRaidRuntimeState: {
  generation: number;
  initialized: boolean;
  verificationVersion: number;
  lockdownVersion: number;
} = {
  generation: 0,
  initialized: false,
  verificationVersion: 0,
  lockdownVersion: 0,
};

/**
 * 广告候选投递是否处在「被 Worker 拒收」的状态。Worker 重建或已放弃自愈期间每条开着
 * 广告检测的群消息都会被拒，错误日志只在由收转拒的边沿记一行、由拒转收时记一行恢复。
 * 容量固定为一个布尔值，随进程生死。
 */
export const adCandidatePostRejected: { current: boolean } = { current: false };
