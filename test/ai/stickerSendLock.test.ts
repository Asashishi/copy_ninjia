import { describe, expect, test } from "bun:test";
import { createStickerSendLock } from "../../src/ai/stickerSendLock";

/**
 * ai/stickerSendLock.ts 的纯逻辑单测：锁的抢占/重入/互斥/释放语义。与
 * send_sticker 执行路径的整合行为（拒绝发送、收回挡位）在
 * test/ai/stickers.test.ts 里覆盖。所有用例注入独立 Map，不碰 Worker 全局
 * 的 stickerSendLocks。
 */

describe("ai/stickerSendLock createStickerSendLock", () => {
  test("空闲即抢占，本轮已持有重入通过，并发句柄抢不到", () => {
    const locks = new Map<number, object>();
    const first = createStickerSendLock(123, locks);
    const second = createStickerSendLock(123, locks);

    expect(first.tryAcquire()).toBe(true);
    expect(first.tryAcquire()).toBe(true); // 重入：发送失败重试不被自己挡住
    expect(second.tryAcquire()).toBe(false);
    expect(locks.size).toBe(1);
  });

  test("release 释放后其他句柄能抢到；已释放句柄不能再抢，release 幂等", () => {
    const locks = new Map<number, object>();
    const first = createStickerSendLock(123, locks);
    expect(first.tryAcquire()).toBe(true);

    first.release();
    expect(locks.size).toBe(0);
    first.release(); // 幂等

    const second = createStickerSendLock(123, locks);
    expect(second.tryAcquire()).toBe(true);
    // 轮结束后迟到的工具调用不能复活已释放句柄的锁。
    expect(first.tryAcquire()).toBe(false);
  });

  test("未持锁句柄的 release 不清并发轮持有的锁", () => {
    const locks = new Map<number, object>();
    const holder = createStickerSendLock(123, locks);
    const loser = createStickerSendLock(123, locks);
    expect(holder.tryAcquire()).toBe(true);
    expect(loser.tryAcquire()).toBe(false);

    loser.release();
    expect(locks.size).toBe(1);
    expect(holder.tryAcquire()).toBe(true);
  });

  test("锁按群隔离：不同 chatId 各自独立", () => {
    const locks = new Map<number, object>();
    expect(createStickerSendLock(123, locks).tryAcquire()).toBe(true);
    expect(createStickerSendLock(456, locks).tryAcquire()).toBe(true);
    expect(locks.size).toBe(2);
  });
});
