import { beforeEach, describe, expect, jest, test } from "bun:test";
import type { Message } from "grammy/types";
import {
  isBotOwnMessage,
  isSelfSent,
  markSelfSent,
  needsBotOwnMessageWait,
  waitForBotOwnMessage,
} from "../../packages/infra/selfSentTracker";
import {
  pendingSelfSentWaiters,
  resetSelfSentTracker,
  sentMessageCount,
  sentMessages,
} from "../../packages/cache/perThread/selfSentTracker";
import { SELF_SENT_MESSAGE_TTL_MS } from "../../packages/consts/telegram";

beforeEach(resetSelfSentTracker);

describe("跨线程自发消息 rendezvous", () => {
  test("频道 update 先到、sent 后到时立即唤醒并判为机器人自己的消息", async () => {
    const message: Message = {
      message_id: 10,
      date: 1,
      chat: { id: -1001, type: "channel", title: "Channel" },
      text: "bot post",
    } as Message;

    const matched: Promise<boolean> = waitForBotOwnMessage(message);
    expect(needsBotOwnMessageWait(message)).toBeTrue();
    expect(pendingSelfSentWaiters.size).toBe(1);
    markSelfSent(-1001, 10);

    await expect(matched).resolves.toBeTrue();
    expect(pendingSelfSentWaiters.size).toBe(0);
  });

  test("关联讨论组自动转发按频道原帖编号等待标记", async () => {
    const message: Message = {
      message_id: 20,
      date: 1,
      chat: { id: -2002, type: "supergroup", title: "Discussion" },
      is_automatic_forward: true,
      forward_origin: {
        type: "channel",
        date: 1,
        chat: { id: -1001, type: "channel", title: "Channel" },
        message_id: 11,
      },
      text: "forwarded bot post",
    } as Message;

    const matched: Promise<boolean> = waitForBotOwnMessage(message);
    expect(needsBotOwnMessageWait(message)).toBeTrue();
    markSelfSent(-1001, 11);

    await expect(matched).resolves.toBeTrue();
  });

  test("普通群消息不创建等待项；频道消息超时后按外部消息放行", async () => {
    const groupMessage: Message = {
      message_id: 30,
      date: 1,
      chat: { id: -3003, type: "supergroup", title: "Group" },
      text: "hello",
    } as Message;
    expect(needsBotOwnMessageWait(groupMessage)).toBeFalse();
    await expect(waitForBotOwnMessage(groupMessage)).resolves.toBeFalse();
    expect(pendingSelfSentWaiters.size).toBe(0);

    const channelMessage: Message = {
      message_id: 31,
      date: 1,
      chat: { id: -3004, type: "channel", title: "Channel" },
      text: "external post",
    } as Message;
    await expect(waitForBotOwnMessage(channelMessage, 0)).resolves.toBeFalse();
    expect(pendingSelfSentWaiters.size).toBe(0);
  });
});

/**
 * 分层表的容量语义：外层 chatId、内层 messageId，内层空了必须连带摘除外层。
 *
 * 这条是分层改造引入的新不变量，且它承载着 isSelfSent 的空表快速路径——
 * 只要有一个群留下空的内层表，`sentMessages.size === 0` 就再也不成立，
 * 每条群消息都会白付一次外层查找，泄漏的空 Map 也永远不回收。
 */
describe("自发消息登记的分层容量", () => {
  test("同群多条各自计数，TTL 到期后内层与外层一起摘除", () => {
    jest.useFakeTimers();
    try {
      markSelfSent(-1001, 10);
      markSelfSent(-1001, 11);
      markSelfSent(-2002, 20);

      expect(sentMessageCount()).toBe(3);
      expect(sentMessages.size).toBe(2);
      expect(sentMessages.get(-1001)?.size).toBe(2);
      expect(isSelfSent(-1001, 10)).toBeTrue();
      expect(isSelfSent(-1001, 12)).toBeFalse();
      // 另一个群的同号消息不得串味：复合串时代这是一个键，分层后是两层。
      expect(isSelfSent(-2002, 10)).toBeFalse();

      jest.advanceTimersByTime(SELF_SENT_MESSAGE_TTL_MS);

      // 逐条到期后不能留下空的内层 Map：外层非空会让 isSelfSent 的空表快速路径
      // 永久失效，泄漏的空 Map 也再无人回收。
      expect(sentMessageCount()).toBe(0);
      expect(sentMessages.size).toBe(0);
      expect(isSelfSent(-1001, 10)).toBeFalse();
    } finally {
      jest.useRealTimers();
    }
  });

  test("线程停止时带着在途 waiter 一起清空，不留悬挂 timer", async () => {
    const channelMessage: Message = {
      message_id: 40,
      date: 1,
      chat: { id: -4004, type: "channel", title: "Channel" },
      text: "pending",
    } as Message;

    // 有界 rendezvous 尚未判定就赶上线程停止：teardown 必须把 waiter 的 timer
    // 一并清掉，否则这批 timer 会一直挂到 rendezvous 超时才结算。
    const pending: Promise<boolean> = waitForBotOwnMessage(channelMessage, 60_000);
    markSelfSent(-1001, 10);
    expect(pendingSelfSentWaiters.size).toBe(1);
    expect(sentMessageCount()).toBe(1);

    resetSelfSentTracker();

    expect(pendingSelfSentWaiters.size).toBe(0);
    expect(sentMessages.size).toBe(0);
    // waiter 被清掉后这条 promise 不再有结算方；断言它在下一拍仍未结算即可。
    const settled: unknown = await Promise.race([
      pending.then((): string => "settled"),
      Promise.resolve("still-pending"),
    ]);
    expect(settled).toBe("still-pending");
  });

  test("重复登记同一条只保留一个 timer，不重复占用条目", () => {
    markSelfSent(-1001, 10);
    const first: ReturnType<typeof setTimeout> | undefined =
      sentMessages.get(-1001)?.get(10);
    markSelfSent(-1001, 10);
    const second: ReturnType<typeof setTimeout> | undefined =
      sentMessages.get(-1001)?.get(10);

    expect(sentMessageCount()).toBe(1);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(SELF_SENT_MESSAGE_TTL_MS).toBeGreaterThan(0);
  });

  test("自动转发按频道原帖判回环，讨论组副本自身编号不参与", () => {
    markSelfSent(-1001, 11);
    const forwarded: Message = {
      message_id: 20,
      date: 1,
      chat: { id: -2002, type: "supergroup", title: "Discussion" },
      is_automatic_forward: true,
      forward_origin: {
        type: "channel",
        date: 1,
        chat: { id: -1001, type: "channel", title: "Channel" },
        message_id: 11,
      },
      text: "forwarded bot post",
    } as Message;

    expect(isBotOwnMessage(forwarded)).toBeTrue();
    expect(isSelfSent(-2002, 20)).toBeFalse();
  });
});
