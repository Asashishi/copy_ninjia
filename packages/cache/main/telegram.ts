/**
 * 主线程唯一的 Telegram 客户端与按类别 429 退避运行态。
 *
 * owner：main。正常请求不排队；Telegram 返回 429 后，请求及同类别后来者进入
 * 对应侵入式 FIFO。全类别合计最多 81,920 条，超出即拒绝；Worker 崩溃时其代际
 * signal 会 O(1) 摘除。进程重启从空队列开始，安全动作由 verification 快照和
 * blocklist outbox 重放，退避层不复制持久化权威。客户端初始化与首次 429 分别
 * 填充单例句柄和对应类别队列。
 */

import type {
  TelegramOutboundDrainWaiter,
  TelegramOutboundJob,
  TelegramRetryCategory,
  TelegramRetryLane,
} from "../../types/telegramOutbound";

function createRetryLane(): TelegramRetryLane {
  return {
    head: null,
    tail: null,
    activeCount: 0,
    pendingCount: 0,
    retryAt: 0,
    retryTimer: null,
    recoveryLimit: 1,
    recoveryActive: 0,
    recovering: false,
  };
}

/** Telegram transformer 是否已安装。 */
export const telegramClientInitialization: { current: boolean } = { current: false };

/**
 * Telegram 出站 owner 当前是否接受新工作。应用初始化时置真，所有生产者排空后
 * 由生命周期置假；进程内重复初始化会重新武装。容量恒为一个布尔值。
 */
export const telegramOutboundAccepting: { current: boolean } = { current: true };

/**
 * 当前 Telegram 出站生命周期的统一取消源。初始化时替换为新 controller；排空
 * 预算耗尽时 abort，使 grammY/fetch 中的真实网络请求和 429 重试同时停止。
 */
export const telegramOutboundAbortController: { current: AbortController } = {
  current: new AbortController(),
};

/**
 * 主线程唯一 Telegram 出站 429 队列的计数、active 对象、类别状态与排空等待者。
 * activeJobs 只保存已开始且未结算的现有 job，预算耗尽时用于同步取消；正常或
 * 取消结算立即删除。容量为 active 请求数加 81,920 条 pending 硬顶，进程重启
 * 从空状态开始。
 */
export const telegramOutboundGateState: {
  activeCount: number;
  retryPendingCount: number;
  aborting: boolean;
  readonly activeJobs: Set<TelegramOutboundJob>;
  readonly lanes: Readonly<Record<TelegramRetryCategory, TelegramRetryLane>>;
  readonly drainWaiters: Set<TelegramOutboundDrainWaiter>;
} = {
  activeCount: 0,
  retryPendingCount: 0,
  aborting: false,
  activeJobs: new Set(),
  lanes: {
    message: createRetryLane(),
    inline: createRetryLane(),
    download: createRetryLane(),
    kick: createRetryLane(),
    query: createRetryLane(),
    restrict: createRetryLane(),
    delete: createRetryLane(),
    chatAction: createRetryLane(),
    reaction: createRetryLane(),
    callback: createRetryLane(),
    edit: createRetryLane(),
    profile: createRetryLane(),
    management: createRetryLane(),
    other: createRetryLane(),
  },
  drainWaiters: new Set(),
};
