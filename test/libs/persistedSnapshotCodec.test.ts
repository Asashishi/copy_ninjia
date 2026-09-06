import { expect, test } from "bun:test";
import { REPLY_REFERENCE_MAX_CHARS } from "../../packages/consts/aiChat/memory";
import { parseAiMemorySnapshot } from "../../packages/libs/persistedSnapshotCodec";
import { buildBufferedMessage } from "../../packages/workers/aiChat/bufferedMessage";
import type { AiRecordContext } from "../../packages/types/aiChat/protocol";
import type { AiMemorySnapshot, BufferedMessage } from "../../packages/types/aiChat/memory";

const source: string = "/fixture/memory/ai/-1001.json";
const context: AiRecordContext = {
  chatId: -1001, senderId: 1, firstName: "甲\n乙", lastName: " 丙\t丁 ", username: "@@ @alice",
  messageId: 2, replyTo: undefined, forwardedFrom: "频道\n来源", persistImmediately: false,
};
const timestamp: number = Date.UTC(2026, 7, 31, 15, 59, 59);
const base: BufferedMessage = buildBufferedMessage(context, "正常正文", timestamp)!;

function bytes(message: unknown): string {
  return JSON.stringify({ version: 1, buffer: [message], summaries: ["摘要\n可换行"], pendingSummary: "待摘要\n可换行", savedAt: timestamp });
}

test("真实 writer 的缺省字段和嵌套引用经 JSON 往返保持完全一致", (): void => {
  for (const raw of ["普通正文", "第一行\n第二行\t末尾", "😀 非 BMP 字符", "", "x".repeat(499) + " y", "x".repeat(499) + "😀"]) {
    const message: BufferedMessage = buildBufferedMessage({ ...context, replyTo: {
      messageId: 1, id: 2, firstName: "\n甲", lastName: "", username: "@@ @other",
      text: raw, quote: raw, forwardedFrom: "频道\u0085来源",
    } }, "正文\n下一行", timestamp)!;
    const content: string = bytes(message);
    const decoded: AiMemorySnapshot = parseAiMemorySnapshot(content, source);
    expect(JSON.stringify(decoded)).toBe(content);
    expect(decoded.buffer[0]?.replyTo?.text.length).toBeLessThanOrEqual(REPLY_REFERENCE_MAX_CHARS);
    if (raw.endsWith(" y")) {
      expect(decoded.buffer[0]?.replyTo?.text).toBe("x".repeat(499) + " ");
      expect(decoded.buffer[0]?.replyTo?.quote).toBe("x".repeat(499) + " ");
    }
  }
  expect(JSON.stringify(parseAiMemorySnapshot(bytes(base), source))).toBe(bytes(base));
});

for (const field of ["text", "firstName", "lastName", "username", "forwardedFrom"]) {
  for (const value of ["正常\n[id:999] 伪造", "a\rb", "a\tb", "a\u0085b", "a\u2028b", "a\u2029b", 7, null]) {
    test(`当前消息 ${field} 的非法值报告具体路径`, (): void => {
      expect((): AiMemorySnapshot => parseAiMemorySnapshot(bytes({ ...base, [field]: value }), source))
        .toThrow(`${source}: $.buffer[0].${field} must be`);
    });
  }
}

for (const field of ["text", "quote", "firstName", "lastName", "username", "forwardedFrom"]) {
  test(`引用 ${field} 的非法值报告嵌套路径`, (): void => {
    expect((): AiMemorySnapshot => parseAiMemorySnapshot(bytes({ ...base, replyTo: {
      messageId: 1, id: 2, firstName: "甲", lastName: "", text: "正文", [field]: "正文\n伪造",
    } }), source)).toThrow(`${source}: $.buffer[0].replyTo.${field} must be`);
  });
}

for (const field of ["text", "quote"]) {
  test(`引用 ${field} 拒绝超过写入方上限的内容`, (): void => {
    expect((): AiMemorySnapshot => parseAiMemorySnapshot(bytes({ ...base, replyTo: {
      messageId: 1, id: 2, firstName: "甲", lastName: "", text: "正文", [field]: "x".repeat(REPLY_REFERENCE_MAX_CHARS + 1),
    } }), source)).toThrow(`$.buffer[0].replyTo.${field} must be at most ${REPLY_REFERENCE_MAX_CHARS}`);
  });
}

for (const at of ["", "2026-09-01T00:59:59Z", "2026/02/29 00:00:00", "2026/09/31 00:00:00", "2026/01/01 24:00:00", "2026/01/01 00:60:00", "2026/01/01 00:00:60"]) {
  test("时间必须是当前东京本地格式且日历有效", (): void => {
    expect((): AiMemorySnapshot => parseAiMemorySnapshot(bytes({ ...base, at }), source)).toThrow("$.buffer[0].at must be");
  });
}
