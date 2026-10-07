/** owner: main。主线程每聊天发送调度器（packages/infra/telegram/sendScheduler.ts）的运行态。
 *
 * 只有主线程持有真实 Telegram 客户端；Worker 的发送经双工代理回到主线程再进入调度器，
 * 因此这里没有 Worker 镜像，也没有崩溃重建：进程重启从空状态开始，额度窗口随之归零。
 */

import { TELEGRAM_SEND_GLOBAL_LIMIT } from "../../consts/telegram";
import { LinkedQueue } from "../../libs/linkedQueue";
import { TimestampDeque } from "../../libs/timestampDeque";
import type { TelegramSendChatKey, TelegramSendLane } from "../../types/telegramOutbound";

/**
 * 聊天键 → 发送车道。首次向该聊天发送时创建；车道无排队、无在途，且最近一次发送距今
 * 已超过分钟窗口、保守档与 429 冻结都已结束时由车道自己的定时器删除。出站生命周期
 * 全局取消或重新初始化时整表清空。容量为最近一个分钟窗口内发过消息、或仍有排队与冻结的
 * 聊天数；排队总数另受 TELEGRAM_MESSAGE_GLOBAL_PENDING_MAX 约束。
 */
export const sendChatLanes: Map<TelegramSendChatKey, TelegramSendLane> = new Map();

/**
 * 所有聊天共用的全局秒窗口：每放行一条发送按条数记一个时间戳（相册按张数），容量为
 * TELEGRAM_SEND_GLOBAL_LIMIT，放行前修剪。出站生命周期重新初始化时清空。
 */
export const sendGlobalWindow: TimestampDeque = new TimestampDeque(TELEGRAM_SEND_GLOBAL_LIMIT);

/**
 * 只差全局秒窗口额度的车道按到达顺序轮转：全局定时器到点后从队首依次放行，每条车道一次
 * 只放一条，各群轮流放行。车道入队时置 inGlobalRing，出队时清除；同一车道至多
 * 一项，容量不超过 sendChatLanes。全局取消或重新初始化时清空。
 */
export const sendGlobalRing: LinkedQueue<TelegramSendLane> = new LinkedQueue<TelegramSendLane>();

/**
 * 调度器的全局计数与定时器：queuedTotal 为全部车道 FIFO 中的任务数（不含在途），
 * 上限 TELEGRAM_MESSAGE_GLOBAL_PENDING_MAX；globalTimer 在轮转队列非空时等全局窗口腾出
 * 额度，队列清空即不再续挂。全局取消或重新初始化时归零。
 */
export const sendSchedulerState: {
  queuedTotal: number;
  globalTimer: ReturnType<typeof setTimeout> | null;
} = {
  queuedTotal: 0,
  globalTimer: null,
};
