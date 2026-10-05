import { describe, expect, test } from "bun:test";
import { isTelegramMessageRequest, telegramMessageThrottler } from "../../packages/infra/telegram/messageThrottler";
import {
  TELEGRAM_MESSAGE_GLOBAL_REFRESH_INTERVAL_MS,
  TELEGRAM_MESSAGE_GLOBAL_RESERVOIR,
} from "../../packages/consts/telegram";

describe("Telegram 发送类 throttler 分类", () => {
  test("只有实际产生聊天消息、媒体、文件或转发的调用进入 grammY", () => {
    expect(isTelegramMessageRequest("sendMessage")).toBeTrue();
    expect(isTelegramMessageRequest("sendPhoto")).toBeTrue();
    expect(isTelegramMessageRequest("sendAudio")).toBeTrue();
    expect(isTelegramMessageRequest("sendDocument")).toBeTrue();
    expect(isTelegramMessageRequest("copyMessage")).toBeTrue();
    expect(isTelegramMessageRequest("forwardMessages")).toBeTrue();
    expect(isTelegramMessageRequest("sendMessageDraft")).toBeTrue();
  });

  test("inline、聊天状态、管理、查询、删除、反应和回调不进入 grammY", () => {
    expect(isTelegramMessageRequest("answerInlineQuery")).toBeFalse();
    expect(isTelegramMessageRequest("answerWebAppQuery")).toBeFalse();
    expect(isTelegramMessageRequest("sendChatAction")).toBeFalse();
    expect(isTelegramMessageRequest("getChat")).toBeFalse();
    expect(isTelegramMessageRequest("getFile")).toBeFalse();
    expect(isTelegramMessageRequest("banChatMember")).toBeFalse();
    expect(isTelegramMessageRequest("deleteMessage")).toBeFalse();
    expect(isTelegramMessageRequest("setMessageReaction")).toBeFalse();
    expect(isTelegramMessageRequest("answerCallbackQuery")).toBeFalse();
    expect(isTelegramMessageRequest("sendGift")).toBeFalse();
  });
});

test("同群和同私聊连续发送不等待一秒，图片文字仍按各聊天的顺序执行", async () => {
  const throttler = telegramMessageThrottler();
  const seen: number[] = [];
  const first = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const previous = async (_method: unknown, payload: any): Promise<any> => {
    seen.push(payload.sequence);
    if (payload.sequence === 0) {
      started.resolve();
      await first.promise;
    }
    return { ok: true, result: true };
  };
  const pending = Array.from({ length: 6 }, (_, sequence) => throttler(previous,
    sequence % 2 === 0 ? "sendMessage" : "sendPhoto",
    { chat_id: sequence < 3 ? -1001 : 42, sequence } as never));
  try {
    await started.promise;
    expect(seen.filter((sequence) => sequence < 3)).toEqual([0]);
  } finally {
    first.resolve();
  }
  const releasedAt = performance.now();
  const results = await Promise.allSettled(pending);
  expect(results.every((result) => result.status === "fulfilled")).toBeTrue();
  // 同一聊天若按秒排队，余下两条至少要再等两个刷新周期；只与刷新周期比较，不设固定墙钟阈值。
  expect(performance.now() - releasedAt).toBeLessThan(TELEGRAM_MESSAGE_GLOBAL_REFRESH_INTERVAL_MS);
  expect(seen.filter((sequence) => sequence < 3)).toEqual([0, 1, 2]);
  expect(seen.filter((sequence) => sequence >= 3)).toEqual([3, 4, 5]);
});

test("所有聊天的图片和文字共用全局每秒额度", async () => {
  const startedAt = performance.now();
  const throttler = telegramMessageThrottler();
  const times: number[] = [];
  const previous = async (): Promise<any> => {
    times.push(performance.now() - startedAt);
    return { ok: true, result: true };
  };
  const results = await Promise.allSettled(Array.from({ length: TELEGRAM_MESSAGE_GLOBAL_RESERVOIR + 1 }, (_, index) => throttler(
    previous,
    index % 2 === 0 ? "sendPhoto" : "sendMessage",
    { chat_id: index % 2 === 0 ? -1001 - index : 42 + index } as never
  )));
  expect(results.every((result) => result.status === "fulfilled")).toBeTrue();
  expect(times).toHaveLength(TELEGRAM_MESSAGE_GLOBAL_RESERVOIR + 1);
  const lastInWindow: number = times[TELEGRAM_MESSAGE_GLOBAL_RESERVOIR - 1]!;
  const firstAfterRefill: number = times[TELEGRAM_MESSAGE_GLOBAL_RESERVOIR]!;
  // 额度外的那一条必须等到下一次补充（下界，机器繁忙只会让它更晚）；额度内的各条不被逐条
  // 限速，因此它们彼此的跨度小于额度外那一条的等待。
  expect(firstAfterRefill - times[0]!).toBeGreaterThanOrEqual(TELEGRAM_MESSAGE_GLOBAL_REFRESH_INTERVAL_MS * 0.9);
  expect(lastInWindow - times[0]!).toBeLessThan(firstAfterRefill - lastInWindow);
});
