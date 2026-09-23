import { describe, expect, test } from "bun:test";
import { explicitReplyTo, forumTopicThreadId, updateTopicOf } from "../../packages/libs/forumTopic";
import type { Message, Update } from "grammy/types";

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

describe("explicitReplyTo", () => {
  const TOPIC_CREATED: Message = message({
    message_id: 77,
    from: { id: 555, is_bot: false, first_name: "话题创建者" },
    is_topic_message: true,
    message_thread_id: 77,
    forum_topic_created: { name: "话题", icon_color: 0x6fb9f0 },
  });

  test("没有 reply_to_message 时没有回复", () => {
    expect(explicitReplyTo(message({ text: "/block @alice_x" }))).toBeUndefined();
  });

  test("普通群里的显式回复原样返回", () => {
    const replied: Message = message({ message_id: 5, text: "请封 123456789" });
    expect(explicitReplyTo(message({ message_id: 6, reply_to_message: replied as never }))).toBe(replied);
  });

  test("论坛话题里 Bot API 自动填入的话题创建消息不算回复", () => {
    expect(explicitReplyTo(message({
      message_id: 90,
      is_topic_message: true,
      message_thread_id: 77,
      reply_to_message: TOPIC_CREATED as never,
    }))).toBeUndefined();
  });

  test("话题创建消息未带 forum_topic_created 时，按 message_id 等于 message_thread_id 识别", () => {
    const threadRoot: Message = message({ message_id: 77, is_topic_message: true, message_thread_id: 77 });
    expect(explicitReplyTo(message({
      message_id: 90,
      is_topic_message: true,
      message_thread_id: 77,
      reply_to_message: threadRoot as never,
    }))).toBeUndefined();
  });

  test("论坛话题内显式回复另一条话题消息照常返回", () => {
    const replied: Message = message({ message_id: 88, is_topic_message: true, message_thread_id: 77, text: "hi" });
    expect(explicitReplyTo(message({
      message_id: 90,
      is_topic_message: true,
      message_thread_id: 77,
      reply_to_message: replied as never,
    }))).toBe(replied);
  });

  test("讨论组评论线程不是论坛话题：回复频道贴自动转发的顶层评论照常算回复", () => {
    // 评论的 message_thread_id 就是那条自动转发的 message_id，但 is_topic_message 不为 true。
    const channelForward: Message = message({ message_id: 12345, is_automatic_forward: true, text: "频道贴" });
    expect(explicitReplyTo(message({
      message_id: 12346,
      message_thread_id: 12345,
      reply_to_message: channelForward as never,
    }))).toBe(channelForward);
  });
});

describe("updateTopicOf", () => {
  // 可访问消息的 date 恒大于 0；InaccessibleMessage 才以 date: 0 表示。
  const topicMessage: Message = message({ date: 1_700_000_000, is_topic_message: true, message_thread_id: 42 });

  test("消息、频道帖与按钮所在消息位于论坛话题时给出群与话题", () => {
    const expected = { chatId: -1001, threadId: 42 };
    expect(updateTopicOf({ update_id: 1, message: topicMessage } as Update)).toEqual(expected);
    expect(updateTopicOf({ update_id: 2, channel_post: topicMessage } as Update)).toEqual(expected);
    expect(updateTopicOf({
      update_id: 3,
      callback_query: { id: "q", chat_instance: "c", from: { id: 7, is_bot: false, first_name: "A" }, message: topicMessage },
    } as Update)).toEqual(expected);
  });

  test("General、讨论组评论、已不可访问的按钮消息与没有触发消息的 update 一律 undefined", () => {
    expect(updateTopicOf({ update_id: 1, message: message({}) } as Update)).toBeUndefined();
    expect(updateTopicOf({ update_id: 2, message: message({ message_thread_id: 42 }) } as Update)).toBeUndefined();
    expect(updateTopicOf({
      update_id: 3,
      callback_query: {
        id: "q",
        chat_instance: "c",
        from: { id: 7, is_bot: false, first_name: "A" },
        message: { chat: CHAT, message_id: 1, date: 0 },
      },
    } as Update)).toBeUndefined();
    expect(updateTopicOf({ update_id: 4, inline_query: { id: "i", from: { id: 7, is_bot: false, first_name: "A" }, query: "", offset: "" } } as Update))
      .toBeUndefined();
  });
});
