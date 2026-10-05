import { afterEach, expect, test } from "bun:test";
import { REPLY_DELIVERY_MAX_PER_CHAT, REPLY_DELIVERY_MAX_TOTAL, REPLY_TRIGGER_QUEUE_MAX } from "../../../packages/consts/aiChat/rateLimit";
import { STATE_MANAGED_CHAT_LIMIT } from "../../../packages/consts/storage";
import { resetAiChatReplyCache } from "../../../packages/cache/workers/aiChat/replies";
import * as delivery from "../../../packages/workers/aiChat/replyDelivery";
import { runReplyDeliveryPressure } from "../../helpers/replyDeliveryPressure";
import type { DeliveryApi, DeliveryPressureOptions, DeliveryPressureResult } from "../../helpers/replyDeliveryPressure";
import type { ReplyDeliveryTurn } from "../../../packages/types/aiChat/replies";

afterEach(resetAiChatReplyCache);

test("压力夹具拒绝越过慢队首的提前 ready", async (): Promise<void> => {
  const reserved: ReplyDeliveryTurn[] = [];
  const prematurelyReady: DeliveryApi = {
    ...delivery,
    reserveReplyDelivery(chatId: number): ReplyDeliveryTurn | undefined {
      const turn: ReplyDeliveryTurn | undefined = delivery.reserveReplyDelivery(chatId);
      if (turn === undefined) return turn;
      reserved.push(turn);
      if (turn.direct) return turn;
      return { ...turn, ready: Promise.resolve() };
    },
  };
  try {
    await expect(runReplyDeliveryPressure({ delivery: prematurelyReady, mode: "singleChat" }))
      .rejects.toThrow("started a send before the preceding turn finished");
  } finally {
    for (const turn of reserved) await turn.finish();
  }
});

test("压力夹具拒绝前轮发送尚未完成时重叠发送", async (): Promise<void> => {
  const reserved: ReplyDeliveryTurn[] = [];
  const waiting: PromiseWithResolvers<void>[] = [];
  const overlappingSends: DeliveryApi = {
    ...delivery,
    reserveReplyDelivery(chatId: number): ReplyDeliveryTurn | undefined {
      const turn: ReplyDeliveryTurn | undefined = delivery.reserveReplyDelivery(chatId);
      if (turn === undefined) return turn;
      reserved.push(turn);
      if (turn.direct) {
        return {
          ...turn,
          commit(): void {
            turn.commit();
            for (const ready of waiting) ready.resolve();
          },
        };
      }
      const ready: PromiseWithResolvers<void> = Promise.withResolvers<void>();
      waiting.push(ready);
      return { ...turn, ready: ready.promise };
    },
  };
  try {
    await expect(runReplyDeliveryPressure({ delivery: overlappingSends, mode: "singleChat" }))
      .rejects.toThrow("started a send before the preceding turn finished");
  } finally {
    for (const turn of reserved) await turn.finish();
  }
});

test.each(["singleChat", "multiChat", "retryCancel"] as const)("持续到达压力 %s：有界等待、完整回收与确定顺序", async (mode: DeliveryPressureOptions["mode"]): Promise<void> => {
  const first: DeliveryPressureResult = await runReplyDeliveryPressure({ delivery, mode });
  const second: DeliveryPressureResult = await runReplyDeliveryPressure({ delivery, mode });
  expect(second).toEqual(first);
  expect(first.completed + first.cancelled + first.rejected).toBe(first.arrivals);
  expect(first.completed).toBeGreaterThan(0);
  expect(first.rejected).toBeGreaterThan(0);
  expect(first.peakChatQueued).toBe(REPLY_TRIGGER_QUEUE_MAX);
  expect(first.peakQueued).toBeLessThanOrEqual(STATE_MANAGED_CHAT_LIMIT * REPLY_TRIGGER_QUEUE_MAX);
  expect(first.peakPerChat).toBeLessThanOrEqual(REPLY_DELIVERY_MAX_PER_CHAT);
  expect(first.peakLive).toBeLessThanOrEqual(REPLY_DELIVERY_MAX_TOTAL);
  expect(first.triggerWaitP99Ms).toBeGreaterThan(0);
  expect(first.deliveryWaitP99Ms).toBeGreaterThan(0);
  expect(first.endToEndP99Ms).toBeGreaterThanOrEqual(first.endToEndP95Ms);
  if (mode === "singleChat") expect(first.peakPerChat).toBe(REPLY_DELIVERY_MAX_PER_CHAT);
  else expect(first.peakLive).toBe(REPLY_DELIVERY_MAX_TOTAL);
  if (mode === "retryCancel") {
    expect(first.cancelled).toBeGreaterThan(0);
    expect(first.retryWaits).toBeGreaterThan(0);
  } else expect(first.cancelled).toBe(0);
});
