import { afterEach, expect, test } from "bun:test";
import { reserveReplyDelivery } from "../../../packages/workers/aiChat/replyDelivery";
import { invalidateChatReplyCache, replyDeliveryWindows, resetAiChatReplyCache } from "../../../packages/cache/workers/aiChat/replies";
import { REPLY_ROUND_MAX_CONCURRENT } from "../../../packages/consts/aiChat/rateLimit";
import type { ReplyDeliveryTurn } from "../../../packages/types/aiChat/replies";

afterEach(resetAiChatReplyCache);

test("固定桶容纳多轮链，后轮先就绪也必须按入站顺位执行", async () => {
  const order: number[] = [];
  const turns: ReplyDeliveryTurn[] = [];
  const total: number = REPLY_ROUND_MAX_CONCURRENT * 3 + 1;
  for (let i: number = 0; i < total; i++) {
    const turn = reserveReplyDelivery(1);
    turns.push(turn);
    void turn.ready.then(() => { order.push(i); });
  }
  const window = replyDeliveryWindows.get(1)!;
  expect(window.slots).toHaveLength(REPLY_ROUND_MAX_CONCURRENT);
  expect(window.size).toBe(total);
  expect(window.slots[0]!.size).toBe(4);
  for (let i: number = turns.length - 1; i > 0; i--) turns[i]!.commit();
  await Promise.resolve();
  expect(order).toEqual([]);
  turns[0]!.commit();
  for (let i: number = 0; i < total; i++) {
    await turns[i]!.ready;
    expect(order).toEqual(Array.from({ length: i + 1 }, (_, index) => index));
    await turns[i]!.finish();
    expect(window.slots).toHaveLength(REPLY_ROUND_MAX_CONCURRENT);
  }
  expect(replyDeliveryWindows.size).toBe(0);
  expect(window.slots.every((bucket) => bucket.size === 0)).toBe(true);
});

test("空轮提前完成不放行更晚回复，轮到完成项时直接跳过", async () => {
  const first = reserveReplyDelivery(1);
  const empty = reserveReplyDelivery(1);
  const third = reserveReplyDelivery(1);
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

test("群之间独立，旧代迟到回收不能删除新窗口", async () => {
  const old = reserveReplyDelivery(1);
  const other = reserveReplyDelivery(2);
  other.commit();
  await other.ready;
  await other.finish();
  invalidateChatReplyCache(1);
  const fresh = reserveReplyDelivery(1);
  const window = replyDeliveryWindows.get(1);
  await old.finish();
  expect(replyDeliveryWindows.get(1)).toBe(window);
  fresh.commit();
  await fresh.ready;
  await fresh.finish();
  expect(replyDeliveryWindows.size).toBe(0);
});

test("顺位句柄在编译期不可替换", async () => {
  const turn = reserveReplyDelivery(1);
  const window = replyDeliveryWindows.get(1)!;
  const assertReadonly = (): void => {
    // @ts-expect-error 顺位等待句柄只读。
    turn.ready = Promise.resolve();
    // @ts-expect-error 调用链就绪句柄只读。
    turn.commit = (): void => {};
    // @ts-expect-error 生命周期收尾句柄只读。
    turn.finish = async (): Promise<void> => {};
    // @ts-expect-error 发送桶数组只能修改桶内队列，不能替换桶或改变数组长度。
    window.slots[0] = window.slots[0]!;
  };
  void assertReadonly;
  await turn.finish();
});
