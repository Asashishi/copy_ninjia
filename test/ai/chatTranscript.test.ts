import { describe, expect, test } from "bun:test";
import { buildColdMemoryBlock, buildTieredVerbatimTranscript, formatBufferedMessageLine } from "../../src/ai/utils/chatTranscript";
import { COMPACT_BATCH_SIZE } from "../../src/consts/aiChat";
import { CHAT_MEMORY_PRIORITY_INSTRUCTION } from "../../src/consts/aiChatPrompts";
import type { BufferedMessage } from "../../src/types";

const legacyMessage: BufferedMessage = {
  id: 42,
  firstName: "千早",
  lastName: "愛音",
  text: "咋啦",
  at: "2026/07/17 18:18:42",
};

describe("AI 群聊转录身份格式", () => {
  test("有公开 username 时输出可供 @ 提及映射的标记", () => {
    expect(formatBufferedMessageLine({ ...legacyMessage, username: "anon_tokyo" })).toBe(
      "[2026/07/17 18:18:42] [id:42] [username:@anon_tokyo] 千早 愛音：咋啦"
    );
  });

  test("没有 username 的旧缓存条目保持原有转录格式", () => {
    expect(formatBufferedMessageLine(legacyMessage)).toBe(
      "[2026/07/17 18:18:42] [id:42] 千早 愛音：咋啦"
    );
  });

  test("显式标出回复对象、原消息和局部引用，不让模型靠相邻上下文猜", () => {
    expect(formatBufferedMessageLine({
      ...legacyMessage,
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

  test("逐字缓存把最新一个压缩块单列为最热判断标准", () => {
    const messages: BufferedMessage[] = Array.from({ length: COMPACT_BATCH_SIZE + 1 }, (_, index: number) => ({
      ...legacyMessage,
      id: index + 1,
      text: `消息 ${index + 1}`,
    }));
    const transcript: string = buildTieredVerbatimTranscript(messages);

    expect(transcript).toContain("【较早逐字记录（次要背景）】");
    expect(transcript).toContain("[id:1] 千早 愛音：消息 1");
    expect(transcript).toContain(`【最热记忆（重要判断标准，最新最多 ${COMPACT_BATCH_SIZE} 条）】`);
    expect(transcript.indexOf("【最热记忆")).toBeLessThan(transcript.indexOf("[id:2] 千早 愛音：消息 2"));
    expect(transcript).toEndWith(`[id:${COMPACT_BATCH_SIZE + 1}] 千早 愛音：消息 ${COMPACT_BATCH_SIZE + 1}`);
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
});
