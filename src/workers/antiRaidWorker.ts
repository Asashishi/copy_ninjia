import {
  handleJoin,
  handleTrackedMessage,
  handleVerificationCallback,
  dispatchVerification,
  adoptVerifications,
} from "./antiRaid/verificationRuntime";
import { adoptLockdowns } from "./antiRaid/lockdownRuntime";
import { applyAdminChange } from "./antiRaid/adminCache";
import { ANTI_RAID_CACHE_SWEEP_INTERVAL_MS } from "../consts/antiRaid";
import { sweepAdminCache } from "../cache/antiRaid/admins";
import { sweepLinkedChannelCache } from "../cache/antiRaid/linkedChannels";
import { sweepVerificationRevisionCache } from "../cache/antiRaid/verification";
import type { AntiRaidWorkerMessage } from "../types";
import { initTelegramClients } from "../infra/telegram";
import { sweepRecentComments } from "./antiRaid/recentComments";

/**
 * 入群守卫线程（Bun Worker）：入群验证 + 反刷群私密模式的合并流水线。
 * 主线程（src/auto/message/ / index.ts → antiRaid.ts 代理）只做事件投递。
 *
 * 本文件是两台状态机（src/states/verification.ts / lockdown.ts）的解释器
 * 入口：具体解释逻辑分别在 antiRaid/verificationRuntime.ts（入群验证）与
 * antiRaid/lockdownRuntime.ts（私密模式）；五类状态各自由 cache/antiRaid/
 * 下的领域模块持有。本文件只剩消息路由与缓存 sweep 调度。
 * 关键约定（详见各 runtime 模块头）：
 * - dispatch 里状态更替是同步的，副作用（网络请求）一律事后执行——消息
 *   按 FIFO 逐条处理，同一波刷屏入群的后续投递不会被网络往返卡住，
 *   越过阈值那次入群触发的私密模式占位对同批后续入群立即生效。
 * - 异步回调（提醒落地回填、管理员核查）以「状态对象同一性」识别过期：
 *   状态一旦被替换/删除，捕获的旧引用对不上，回调自动放弃。
 *
 * 发往 Telegram 的调用不回主线程绕路——本线程 import infra/telegram/ 时会得到
 * 自己独立的 grammY Api 客户端（用带限流 + 429 自动重试的 joinVerificationApi，
 * 突发的删/踢/发在这里排队，不占用主线程共享客户端）。error 日志经 logger.ts
 * 的转发模式回传主线程统一落盘。
 *
 * lockdown/unlock 与 pending verification 变化都会回报主线程；前者写入
 * state.json，后者由主线程转投 Disk I/O Worker 的当日增量 JSON。两者都可
 * 在 Worker 或整个进程重建后 adopt。
 */

declare const self: Worker;

/** 路由一条主线程消息；独立导出便于验证协议而不启动真实 Worker。 */
export function handleAntiRaidWorkerMessage(msg: AntiRaidWorkerMessage): void {
  switch (msg.type) {
    case "join":
      handleJoin(msg);
      break;
    case "left":
      dispatchVerification(msg.chatId, msg.userId, { type: "left" });
      break;
    case "message":
      handleTrackedMessage(msg);
      break;
    case "callback":
      handleVerificationCallback(msg);
      break;
    case "adopt":
      adoptLockdowns(msg.lockdowns);
      break;
    case "adoptVerifications":
      adoptVerifications(msg);
      break;
    case "adminsChanged":
      applyAdminChange(msg.chatId, msg.userId, msg.isAdmin);
      break;
  }
}

/** TTL 判断不能代替删除：只“视为过期”仍会让 Map 按历史群数永久增长。 */
export function sweepAntiRaidWorkerCaches(now: number = Date.now()): void {
  sweepAdminCache(now);
  sweepLinkedChannelCache(now);
  sweepVerificationRevisionCache(now);
  sweepRecentComments(now);
}

let cacheSweepTimer: ReturnType<typeof setInterval> | null = null;

/** Worker 线程启动入口；主线程导入本模块时不得注册 handler 或 sweeper。 */
export function startAntiRaidWorker(): void {
  if (cacheSweepTimer !== null) return;
  initTelegramClients();
  self.onmessage = (event: MessageEvent<AntiRaidWorkerMessage>) => {
    handleAntiRaidWorkerMessage(event.data);
  };
  cacheSweepTimer = setInterval(sweepAntiRaidWorkerCaches, ANTI_RAID_CACHE_SWEEP_INTERVAL_MS);
  cacheSweepTimer.unref();
  process.once("exit", stopAntiRaidWorker);
}

/** 协作式退出时清掉唯一 sweeper；强制 terminate 时整个 Worker isolate 一并销毁。 */
export function stopAntiRaidWorker(): void {
  if (cacheSweepTimer === null) return;
  clearInterval(cacheSweepTimer);
  cacheSweepTimer = null;
  self.onmessage = null;
  process.off("exit", stopAntiRaidWorker);
}

if (!Bun.isMainThread) startAntiRaidWorker();
