import { describe, expect, test } from "bun:test";
import { buildColdMemoryBlock, buildTieredVerbatimTranscript, formatBufferedMessageLine, formatReplyChain } from "../../src/ai/utils/chatTranscript";
import { COMPACT_BATCH_SIZE, REPLY_CHAIN_NODE_MAX_CHARS } from "../../src/consts/aiChat";
import { CHAT_MEMORY_PRIORITY_INSTRUCTION, SUMMARY_SYSTEM_PROMPT } from "../../src/consts/aiChat/prompts/memory";
import { FORWARD_TAG_HINT, REPLY_CHAIN_SNAPSHOT_TAG, REPLY_TAG_HINT } from "../../src/consts/aiChat/prompts/transcript";
import type { BufferedMessage } from "../../src/types";

const message: BufferedMessage = {
  messageId: 42,
  id: 42,
  firstName: "千早",
  lastName: "愛音",
  text: "咋啦",
  at: "2026/07/17 18:18:42",
};

describe("AI 群聊转录身份格式", () => {
  test("有公开 username 时输出可供 @ 提及映射的标记", () => {
    expect(formatBufferedMessageLine({ ...message, username: "anon_tokyo" })).toBe(
      "[2026/07/17 18:18:42] [message_id:42] [id:42] [username:@anon_tokyo] 千早 愛音：咋啦"
    );
  });

  test("没有 username 的缓存条目仍保留消息索引", () => {
    expect(formatBufferedMessageLine(message)).toBe(
      "[2026/07/17 18:18:42] [message_id:42] [id:42] 千早 愛音：咋啦"
    );
  });

  test("显式标出回复对象、原消息和局部引用，不让模型靠相邻上下文猜", () => {
    expect(formatBufferedMessageLine({
      ...message,
      messageId: 42,
      text: "@ninja_bot 你怎么看",
      replyTo: {
        messageId: 41,
        id: 7,
        firstName: "Bob",
        lastName: "Builder",
        username: "bob_dev",
        text: "第一句 第二句",
        quote: "第二句",
      },
    })).toBe(
      "[2026/07/17 18:18:42] [message_id:42] [id:42] 千早 愛音（回复 [message_id:41] [id:7] [username:@bob_dev] Bob Builder 的消息：「第一句 第二句」；精确引用片段：「第二句」）：@ninja_bot 你怎么看"
    );
  });

  test("标注占位形态由真实模板代入「…」生成，与说明文案不会漂移", () => {
    expect(REPLY_TAG_HINT).toBe("（回复 [message_id:…] … 的消息：「…」）");
    expect(FORWARD_TAG_HINT).toBe("（转发自 …）");
  });

  test("摘要提示按标注层级区分当前转发与被回复原消息的转发", () => {
    expect(SUMMARY_SYSTEM_PROMPT).toContain("直接紧跟当前发言人名字、位于回复标注外层");
    expect(SUMMARY_SYSTEM_PROMPT).toContain("出现在回复标注内部、紧跟「的消息」之后");
    expect(SUMMARY_SYSTEM_PROMPT).toContain("当前正文仍是当前发言人自己写的");
  });

  test("转发消息在名字后标出来源，正文不算发送者本人所写", () => {
    expect(formatBufferedMessageLine({
      ...message,
      messageId: 50,
      text: "转来的爆料",
      forwardedFrom: "[id:789] [username:@carol_cc] Carol Chan",
    })).toBe(
      "[2026/07/17 18:18:42] [message_id:50] [id:42] 千早 愛音（转发自 [id:789] [username:@carol_cc] Carol Chan）：转来的爆料"
    );
  });

  test("被回复的原消息是转发时，回复引用一并标出转发来源", () => {
    expect(formatBufferedMessageLine({
      ...message,
      messageId: 51,
      text: "@ninja_bot 这条你怎么看",
      replyTo: {
        messageId: 50,
        id: 7,
        firstName: "Bob",
        lastName: "Builder",
        text: "转来的爆料",
        forwardedFrom: "频道 [id:-100666] [username:@tokyo_daily] 东京日报",
      },
    })).toBe(
      "[2026/07/17 18:18:42] [message_id:51] [id:42] 千早 愛音（回复 [message_id:50] [id:7] Bob Builder 的消息（转发自 频道 [id:-100666] [username:@tokyo_daily] 东京日报）：「转来的爆料」）：@ninja_bot 这条你怎么看"
    );
  });

  test("逐字缓存把最新一个压缩块单列为最热判断标准", () => {
    const messages: BufferedMessage[] = Array.from({ length: COMPACT_BATCH_SIZE + 1 }, (_, index: number) => ({
      ...message,
      messageId: index + 1,
      id: index + 1,
      text: `消息 ${index + 1}`,
    }));
    const transcript: string = buildTieredVerbatimTranscript(messages);

    expect(transcript).toContain("【较早逐字记录（次要背景）】");
    expect(transcript).toContain("[message_id:1] [id:1] 千早 愛音：消息 1");
    expect(transcript).toContain(`【最热记忆（重要判断标准，最新最多 ${COMPACT_BATCH_SIZE} 条）】`);
    expect(transcript.indexOf("【最热记忆")).toBeLessThan(
      transcript.indexOf("[message_id:2] [id:2] 千早 愛音：消息 2")
    );
    expect(transcript).toEndWith(
      `[message_id:${COMPACT_BATCH_SIZE + 1}] [id:${COMPACT_BATCH_SIZE + 1}] 千早 愛音：消息 ${COMPACT_BATCH_SIZE + 1}`
    );
  });

  test("总提示只保留两层记忆仲裁：逐字转录定当前状态，冷记忆只作长期背景", () => {
    expect(CHAT_MEMORY_PRIORITY_INSTRUCTION).toContain("只分两层仲裁");
    expect(CHAT_MEMORY_PRIORITY_INSTRUCTION).toContain("只依据逐字转录");
    expect(CHAT_MEMORY_PRIORITY_INSTRUCTION).toContain("不用于判断当前状态");

    const coldBlock: string = buildColdMemoryBlock(["较早摘要", "更近摘要"]);
    expect(coldBlock).toStartWith("【冷记忆（长期背景）】");
    expect(coldBlock).toContain("只用于理解长期话题");
    expect(coldBlock).toContain("当前状态以逐字记录为准");
    expect(coldBlock).toContain("1. 较早摘要\n2. 更近摘要");
  });

  test("多层回复链标注按编号列出各跳并截断超长正文", () => {
    const longText: string = "长".repeat(REPLY_CHAIN_NODE_MAX_CHARS + 20);
    const block: string = formatReplyChain(90, [
      {
        messageId: 81,
        id: 1,
        firstName: "Alice",
        lastName: "",
        username: "alice_dev",
        text: "第一跳原文",
        forwardedFrom: "频道 [id:-100666] 东京日报",
        snapshotOnly: false,
      },
      { messageId: 70, id: 2, firstName: "Bob", lastName: "", text: longText, snapshotOnly: true },
    ]);
    expect(block).toContain("本轮触发消息（[message_id:90]）处在一条多层回复链上");
    expect(block).toContain("1. [message_id:81] [id:1] [username:@alice_dev] Alice（转发自 频道 [id:-100666] 东京日报）：「第一跳原文」");
    expect(block).toContain(`2. [message_id:70] [id:2] Bob ${REPLY_CHAIN_SNAPSHOT_TAG}：「${"长".repeat(REPLY_CHAIN_NODE_MAX_CHARS)}」`);
    expect(block).toContain(`${REPLY_CHAIN_SNAPSHOT_TAG}，它是上一条消息自带的回复快照`);
    expect(block).toContain("除链尾快照外，完整原文以逐字记录为准");
    expect(block).not.toContain(longText);
  });

  test("回复链不足 2 跳时返回空串，不产生重复标注", () => {
    expect(formatReplyChain(90, [])).toBe("");
    expect(formatReplyChain(90, [
      { messageId: 81, id: 1, firstName: "Alice", lastName: "", text: "只有单跳", snapshotOnly: false },
    ])).toBe("");
  });
});
