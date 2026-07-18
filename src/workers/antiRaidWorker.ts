import {
  handleJoin,
  handleTrackedMessage,
  handleVerificationCallback,
  dispatchVerification,
} from "./antiRaid/verificationRuntime";
import { adoptLockdowns } from "./antiRaid/lockdownRuntime";
import { applyAdminChange } from "./antiRaid/adminCache";
import { ADMIN_CACHE_TTL_MS, ANTI_RAID_CACHE_SWEEP_INTERVAL_MS, LINKED_CHANNEL_TTL_MS } from "../consts/antiRaid";
import { adminFetches, chatAdmins, linkedChannelFetches, linkedChannels } from "../cache/antiRaidWorker";
import type { AntiRaidWorkerMessage } from "../types";

/**
 * 入群守卫线程（Bun Worker）：入群验证 + 反刷群私密模式的合并流水线。
 * 主线程（src/auto/message/ / index.ts → antiRaid.ts 代理）只做事件投递。
 *
 * 本文件是两台状态机（src/states/verification.ts / lockdown.ts）的解释器
 * 入口：具体解释逻辑分别在 antiRaid/verificationRuntime.ts（入群验证）与
 * antiRaid/lockdownRuntime.ts（私密模式），管理员表缓存在
 * antiRaid/adminCache.ts，频道评论区暂存在 antiRaid/recentComments.ts，
 * 关联频道判定在 antiRaid/linkedChannel.ts。本文件只剩消息路由与缓存 sweep。
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
 * lockdown/unlock 事件回报主线程用于持久化 + Worker 崩溃后的 adopt 重放，
 * 机制见 antiRaid.ts（验证状态则随线程丢失：残留的验证按钮点了会得到
 * 「已失效」应答，重新进群即可）。
 */

declare const self: Worker;

self.onmessage = (event: MessageEvent<AntiRaidWorkerMessage>) => {
  const msg: AntiRaidWorkerMessage = event.data;
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
    case "adminsChanged":
      applyAdminChange(msg.chatId, msg.userId, msg.isAdmin);
      break;
  }
};

/** TTL 判断不能代替删除：只“视为过期”仍会让 Map 按历史群数永久增长。 */
setInterval(() => {
  const now: number = Date.now();
  for (const [chatId, cached] of chatAdmins) {
    if (now - cached.fetchedAt > ADMIN_CACHE_TTL_MS && !adminFetches.has(chatId)) chatAdmins.delete(chatId);
  }
  for (const [chatId, cached] of linkedChannels) {
    if (now - cached.fetchedAt > LINKED_CHANNEL_TTL_MS && !linkedChannelFetches.has(chatId)) linkedChannels.delete(chatId);
  }
}, ANTI_RAID_CACHE_SWEEP_INTERVAL_MS).unref();
