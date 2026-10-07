import { afterEach, expect, test } from "bun:test";
import { hasLiveReplyRounds, hasReplyDeliveryCapacity, isDirectReplyModelActive, reserveReplyDelivery } from "../../../packages/workers/aiChat/replyDelivery";
import { invalidateChatReplyCache, replyDeliveryCounts, replyDeliveryTotal, replyDeliveryWindows, resetAiChatReplyCache } from "../../../packages/cache/workers/aiChat/replies";
import { REPLY_DELIVERY_MAX_PER_CHAT, REPLY_DELIVERY_MAX_TOTAL, REPLY_ROUND_MAX_CONCURRENT } from "../../../packages/consts/aiChat/rateLimit";
import { LinkedQueue } from "../../../packages/libs/linkedQueue";
import type { ReplyDeliverySlot, ReplyDeliveryTurn } from "../../../packages/types/aiChat/replies";

afterEach(resetAiChatReplyCache);

test.each(["invalidate", "reset"])("%s 不清掉旧代存活容量，按序完成与重复 finish 只释放一次", async (mode) => {
  const turns = Array.from({ length: REPLY_DELIVERY_MAX_PER_CHAT }, () => reserveReplyDelivery(1)!);
  expect(hasReplyDeliveryCapacity(1)).toBe(false);
  expect(reserveReplyDelivery(1)).toBeUndefined();
  if (mode === "reset") resetAiChatReplyCache();
  else invalidateChatReplyCache(1);
  expect(reserveReplyDelivery(1)).toBeUndefined();
  const last = turns.at(-1)!;
  const lastFinished = last.finish();
  expect(replyDeliveryTotal.current).toBe(REPLY_DELIVERY_MAX_PER_CHAT);
  await turns[0]!.finish();
  const fresh = reserveReplyDelivery(1)!;
  expect(fresh).toBeDefined();
  const freshWindow = replyDeliveryWindows.get(1);
  for (const turn of turns) await turn.finish();
  await lastFinished;
  expect(replyDeliveryCounts.get(1)).toBe(1);
  expect(replyDeliveryTotal.current).toBe(1);
  expect(replyDeliveryWindows.get(1)).toBe(freshWindow);
  await fresh.finish();
  expect(replyDeliveryCounts.size).toBe(0);
  expect(replyDeliveryTotal.current).toBe(0);
});

test("Worker 总预算限制多群及不断重开的旧代", async () => {
  const turns: ReplyDeliveryTurn[] = [];
  for (let index: number = 0; index < REPLY_DELIVERY_MAX_TOTAL; index++) {
    const chatId: number = index % 8;
    turns.push(reserveReplyDelivery(chatId)!);
    invalidateChatReplyCache(chatId);
  }
  expect(replyDeliveryTotal.current).toBe(REPLY_DELIVERY_MAX_TOTAL);
  expect(hasReplyDeliveryCapacity(99)).toBe(false);
  expect(reserveReplyDelivery(99)).toBeUndefined();
  await turns[0]!.finish();
  const fresh = reserveReplyDelivery(99)!;
  expect(fresh).toBeDefined();
  for (const turn of turns) await turn.finish();
  await fresh.finish();
  expect(replyDeliveryCounts.size).toBe(0);
  expect(replyDeliveryTotal.current).toBe(0);
});

test("同窗容纳多轮链，直接轮当即放行，后轮先就绪也必须等前面的轮按入站顺位执行", async () => {
  const order: number[] = [];
  const turns: ReplyDeliveryTurn[] = [];
  const total: number = REPLY_ROUND_MAX_CONCURRENT * 3 + 1;
  for (let i: number = 0; i < total; i++) {
    const turn = reserveReplyDelivery(1)!;
    turns.push(turn);
    void turn.ready.then(() => { order.push(i); });
  }
  const window = replyDeliveryWindows.get(1)!;
  expect(window.queue.size).toBe(total);
  expect(replyDeliveryCounts.get(1)).toBe(total);
  for (let i: number = turns.length - 1; i > 0; i--) turns[i]!.commit();
  await Promise.resolve();
  // 第一轮是直接轮：占位即放行；其余各轮已 commit，仍等它发完。
  expect(order).toEqual([0]);
  turns[0]!.commit();
  for (let i: number = 0; i < total; i++) {
    await turns[i]!.ready;
    expect(order).toEqual(Array.from({ length: i + 1 }, (_, index) => index));
    await turns[i]!.finish();
    expect(replyDeliveryTotal.current).toBe(total - i - 1);
  }
  expect(replyDeliveryWindows.size).toBe(0);
  expect(window.queue.size).toBe(0);
});

test("空轮提前完成不放行更晚回复，轮到完成项时直接跳过", async () => {
  const first = reserveReplyDelivery(1)!;
  const empty = reserveReplyDelivery(1)!;
  const third = reserveReplyDelivery(1)!;
  let thirdStarted: boolean = false;
  void third.ready.then(() => { thirdStarted = true; });
  const emptyReleased = empty.finish();
  third.commit();
  await Promise.resolve();
  expect(thirdStarted).toBe(false);
  first.commit();
  await first.ready;
  await first.finish();
  await emptyReleased;
  await third.ready;
  expect(thirdStarted).toBe(true);
  await third.finish();
  await third.finish();
  third.commit();
  expect(replyDeliveryWindows.size).toBe(0);
});

test("群里没有在途轮次时是直接轮：占位即放行，commit 交还独立并发位，有序并行轮等它发完", async () => {
  const direct = reserveReplyDelivery(1)!;
  expect(direct.direct).toBe(true);
  let directReady: boolean = false;
  void direct.ready.then(() => { directReady = true; });
  await Promise.resolve();
  expect(directReady).toBe(true);
  expect(isDirectReplyModelActive(1)).toBe(true);
  const parallel = reserveReplyDelivery(1)!;
  expect(parallel.direct).toBe(false);
  let parallelReady: boolean = false;
  void parallel.ready.then(() => { parallelReady = true; });
  expect(replyDeliveryWindows.get(1)?.queue.size).toBe(2);
  // 有序并行轮的完整链已就绪，直接轮也结束了模型阶段，但直接轮没发完：并行轮继续等。
  parallel.commit();
  direct.commit();
  direct.commit();
  expect(isDirectReplyModelActive(1)).toBe(false);
  await Promise.resolve();
  expect(parallelReady).toBe(false);
  await direct.finish();
  await parallel.ready;
  expect(parallelReady).toBe(true);
  // 并行轮还在：下一轮仍是有序并行轮。
  const next = reserveReplyDelivery(1)!;
  expect(isDirectReplyModelActive(1)).toBe(false);
  await parallel.finish();
  next.commit();
  await next.ready;
  await next.finish();
  expect(replyDeliveryWindows.size).toBe(0);
  expect(replyDeliveryCounts.size).toBe(0);
  // 全部清空后，下一轮又是直接轮。
  const again = reserveReplyDelivery(1)!;
  expect(isDirectReplyModelActive(1)).toBe(true);
  again.commit();
  await again.finish();
  expect(replyDeliveryWindows.size).toBe(0);
  expect(replyDeliveryTotal.current).toBe(0);
});

test("群失效后下一轮是新代的直接轮，旧代直接轮迟到收尾不影响新窗口", async () => {
  const old = reserveReplyDelivery(1)!;
  invalidateChatReplyCache(1);
  const fresh = reserveReplyDelivery(1)!;
  const window = replyDeliveryWindows.get(1);
  expect(window?.directModelActive).toBe(true);
  old.commit();
  await old.finish();
  expect(replyDeliveryWindows.get(1)).toBe(window);
  expect(isDirectReplyModelActive(1)).toBe(true);
  fresh.commit();
  await fresh.finish();
  expect(replyDeliveryWindows.size).toBe(0);
  expect(replyDeliveryTotal.current).toBe(0);
});

test("群之间独立，旧代迟到回收不能删除新窗口", async () => {
  const old = reserveReplyDelivery(1)!;
  const other = reserveReplyDelivery(2)!;
  other.commit();
  await other.ready;
  await other.finish();
  invalidateChatReplyCache(1);
  const fresh = reserveReplyDelivery(1)!;
  const window = replyDeliveryWindows.get(1);
  await old.finish();
  expect(replyDeliveryWindows.get(1)).toBe(window);
  fresh.commit();
  await fresh.ready;
  await fresh.finish();
  expect(replyDeliveryWindows.size).toBe(0);
});

test("顺位句柄在编译期不可替换", async () => {
  const turn = reserveReplyDelivery(1)!;
  const window = replyDeliveryWindows.get(1)!;
  const assertReadonly = (): void => {
    // @ts-expect-error 顺位等待句柄只读。
    turn.ready = Promise.resolve();
    // @ts-expect-error 调用链就绪句柄只读。
    turn.commit = (): void => {};
    // @ts-expect-error 生命周期收尾句柄只读。
    turn.finish = async (): Promise<void> => {};
    // @ts-expect-error 发送 FIFO 句柄不可替换。
    window.queue = new LinkedQueue<ReplyDeliverySlot>();
  };
  void assertReadonly;
  await turn.finish();
});

test("存活轮次判定覆盖预留到按序回收的全程，回收完毕即为 false", async () => {
  expect(hasLiveReplyRounds(1)).toBe(false);
  const turn = reserveReplyDelivery(1)!;
  expect(hasLiveReplyRounds(1)).toBe(true);
  turn.commit();
  expect(hasLiveReplyRounds(1)).toBe(true);
  await turn.finish();
  expect(hasLiveReplyRounds(1)).toBe(false);
});
