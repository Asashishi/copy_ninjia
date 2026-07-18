import { describe, expect, test } from "bun:test";
import { buildColdMemoryBlock, buildTieredVerbatimTranscript, formatBufferedMessageLine } from "../../src/ai/utils/chatTranscript";
import { CHAT_MEMORY_PRIORITY_INSTRUCTION, COMPACT_BATCH_SIZE } from "../../src/consts/aiChat";
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

  test("总提示强调热记忆，同时要求冷摘要作为长期背景纳入理解", () => {
    expect(CHAT_MEMORY_PRIORITY_INSTRUCTION).toContain("热记忆是判断当前情况的重要标准");
    expect(CHAT_MEMORY_PRIORITY_INSTRUCTION).toContain("冷记忆也必须纳入理解");

    const coldBlock: string = buildColdMemoryBlock(["较早摘要", "更近摘要"]);
    expect(coldBlock).toStartWith("【冷记忆（长期背景，必须参考）】");
    expect(coldBlock).toContain("不能直接忽略");
    expect(coldBlock).toContain("判断这是否代表状态、观点或关系后来发生了变化");
    expect(coldBlock).toContain("当前状态则以较新的逐字记录为准");
    expect(coldBlock).toContain(`优先参考最新 ${COMPACT_BATCH_SIZE} 条最热记忆`);
    expect(coldBlock).toContain("1. 较早摘要\n2. 更近摘要");
  });
});
