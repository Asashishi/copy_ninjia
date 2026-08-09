import { beforeEach, describe, expect, test } from "bun:test";
import type { Message } from "@grammyjs/types";
import {
  markSelfSent,
  needsBotOwnMessageWait,
  waitForBotOwnMessage,
} from "../../packages/infra/selfSentTracker";
import {
  pendingSelfSentWaiters,
  sentMessages,
} from "../../packages/cache/perThread/selfSentTracker";

function clearTracker(): void {
  for (const timer of sentMessages.values()) clearTimeout(timer);
  sentMessages.clear();
  for (const waiters of pendingSelfSentWaiters.values()) {
    for (const waiter of waiters) clearTimeout(waiter.timer);
  }
  pendingSelfSentWaiters.clear();
}

beforeEach(clearTracker);

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
