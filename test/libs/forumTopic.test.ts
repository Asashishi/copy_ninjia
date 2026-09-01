import { describe, expect, test } from "bun:test";
import { forumTopicThreadId } from "../../packages/libs/forumTopic";
import type { Message } from "grammy/types";

const CHAT: Message["chat"] = { id: -1001, type: "supergroup", title: "论坛群" };

function message(overrides: Partial<Message>): Message {
  return { message_id: 1, date: 0, chat: CHAT, ...overrides } as Message;
}

describe("forumTopicThreadId", () => {
  test("论坛话题内的消息返回话题 id", () => {
    expect(forumTopicThreadId(message({ message_thread_id: 77, is_topic_message: true })))
      .toBe(77);
  });

  test("General 不带 message_thread_id，因此是 undefined——发送侧不设参数正好落回 General", () => {
    expect(forumTopicThreadId(message({ text: "在 General 说话" }))).toBeUndefined();
  });

  test("讨论组评论线程不算话题：它的 message_thread_id 不能当 forum topic 用", () => {
    // 关联频道讨论组的评论也带 message_thread_id，但 Bot API 的发送参数只对
    // forum supergroup 有效，误传只会换一次 400（同 antiRaid/updateIngress.ts）。
    expect(forumTopicThreadId(message({ message_thread_id: 12345 }))).toBeUndefined();
  });

  test("显式 is_topic_message: false 一律不认", () => {
    expect(forumTopicThreadId(message({ message_thread_id: 9, is_topic_message: false })))
      .toBeUndefined();
  });
});
