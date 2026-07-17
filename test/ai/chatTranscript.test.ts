import { describe, expect, test } from "bun:test";
import { formatBufferedMessageLine } from "../../src/ai/chatTranscript";
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
});
