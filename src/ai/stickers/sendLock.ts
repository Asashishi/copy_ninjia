import { stickerSendLocks } from "../../cache/stickers/sendLock";
import type { StickerSendLockControl } from "../../types/stickers/tools";

/**
 * 同群「发贴纸」的跨轮互斥锁。当前 REPLY_ROUND_MAX_CONCURRENT 为 1，
 * 锁仍保留轮令牌所有权边界，避免迟到工具调用越过轮生命周期；若之后重新
 * 开放同群并发，它还会阻止几个并发轮各自发一枚贴纸造成刷屏。锁按群记账
 * （chatId -> 持锁轮令牌）：每轮回复持有自己的句柄，send_sticker 校验通过
 * 后、真正发送前先 tryAcquire——空闲即抢占、本轮已持有则直接通过（发送
 * 失败换一枚重试不受影响），被并发轮抢先则拒绝（喂回模型错误，让它改用
 * 文字回应）；轮结束（无论正常收尾还是异常中断）在 finally 里 release，
 * 只清自己持有的锁。单轮独占（无并发）时锁恒空闲，行为与加锁前一致。
 * REPLY_ROUND_MAX_CONCURRENT 只是可调参数、后续可能增大，不能因为当前为 1
 * 而删除或简化这套锁与轮令牌实现。
 *
 * 锁不设 TTL：持有期严格等于一轮回复的生命周期，轮的 finally 兜底释放，
 * 不存在泄漏后靠超时自愈的问题；Worker 重启时随内存清空。
 */

/** 为一轮回复创建本群发贴纸锁的句柄。locks 可注入仅为单测隔离；生产调用
 *  共享 cache/stickers/sendLock.ts 内、随 Worker 重启清空的 stickerSendLocks。 */
export function createStickerSendLock(chatId: number, locks: Map<number, object> = stickerSendLocks): StickerSendLockControl {
  const token: object = {};
  let released: boolean = false;
  return {
    tryAcquire: (): boolean => {
      // 已释放的句柄恒失败：轮结束后迟到的工具调用不能复活锁，否则它占的
      // 锁没有任何 finally 会再释放。
      if (released) return false;
      const holder: object | undefined = locks.get(chatId);
      if (holder === token) return true;
      if (holder !== undefined) return false;
      locks.set(chatId, token);
      return true;
    },
    release: (): void => {
      if (released) return;
      released = true;
      if (locks.get(chatId) === token) locks.delete(chatId);
    },
  };
}
