import { describe, expect, test } from "bun:test";
import { buildColdMemoryBlock, buildTieredVerbatimTranscript, formatBufferedMessageLine, formatReplyChain } from "../../../packages/aiChat/ai/utils/chatTranscript";
import { COMPACT_BATCH_SIZE, REPLY_CHAIN_NODE_MAX_CHARS } from "../../../packages/consts/aiChat";
import { CHAT_MEMORY_PRIORITY_INSTRUCTION, SUMMARY_SYSTEM_PROMPT } from "../../../packages/consts/aiChat/prompts/memory";
import { FORWARD_TAG_HINT, REPLY_CHAIN_SNAPSHOT_TAG, REPLY_TAG_HINT } from "../../../packages/consts/aiChat/prompts/transcript";
import { FALLBACK_SPEAKER_NAME } from "../../../packages/consts/auto";
import type { BufferedMessage } from "../../../packages/types";
import {
  bufferedMessageFixture,
  bufferedReplyReferenceFixture,
  replyChainLinkFixture,
} from "../../helpers/aiMemoryFixtures";

const message: BufferedMessage = bufferedMessageFixture({
  messageId: 42,
  id: 42,
  firstName: "千早",
  lastName: "愛音",
  text: "咋啦",
  at: "2026/07/17 18:18:42",
});

describe("AI 群聊转录身份格式", () => {
  test("有公开 username 时输出可供 @ 提及映射的标记", () => {
    expect(formatBufferedMessageLine({ ...message, username: "anon_tokyo" })).toBe(
      "[2026/07/17 18:18:42] [message_id:42] [id:42] [username:@anon_tokyo] 千早 愛音：咋啦"
    );
  });

  test("显示名退化：只有一个名字段、全空白、乃至字段缺失都退回占位而不抛", () => {
    // 这里替换掉的是 `[first, last].filter(Boolean).join(" ").trim()`。改写成
    // 直接分支后，`(first || last).trim()` 在两个字段都缺失时会抛 TypeError，
    // 而原写法会安全退到占位符——多出来的那个 `|| ""` 就是为这条守的。转录是
    // 每次回复的必经之地，不能因为一条脏记录把整轮回复打断。
    expect(formatBufferedMessageLine({ ...message, lastName: "" })).toBe(
      "[2026/07/17 18:18:42] [message_id:42] [id:42] 千早：咋啦"
    );
    expect(formatBufferedMessageLine({ ...message, firstName: "" })).toBe(
      "[2026/07/17 18:18:42] [message_id:42] [id:42] 愛音：咋啦"
    );
    expect(formatBufferedMessageLine({ ...message, firstName: "  ", lastName: "  " })).toBe(
      `[2026/07/17 18:18:42] [message_id:42] [id:42] ${FALLBACK_SPEAKER_NAME}：咋啦`
    );
    // 类型上两个字段都是必填 string，磁盘回灌也逐字段校验过；这里刻意越过类型
    // 模拟脏数据，确认它退化成占位而不是抛异常。
    const missing = { ...message } as Partial<BufferedMessage> as BufferedMessage;
    delete (missing as Partial<BufferedMessage>).firstName;
    delete (missing as Partial<BufferedMessage>).lastName;
    expect(formatBufferedMessageLine(missing)).toBe(
      `[2026/07/17 18:18:42] [message_id:42] [id:42] ${FALLBACK_SPEAKER_NAME}：咋啦`
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
      replyTo: bufferedReplyReferenceFixture({
        messageId: 41,
        id: 7,
        firstName: "Bob",
        lastName: "Builder",
        username: "bob_dev",
        text: "第一句 第二句",
        quote: "第二句",
      }),
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
      replyTo: bufferedReplyReferenceFixture({
        messageId: 50,
        id: 7,
        firstName: "Bob",
        lastName: "Builder",
        text: "转来的爆料",
        forwardedFrom: "频道 [id:-100666] [username:@tokyo_daily] 东京日报",
      }),
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

  test("消息数不超过一个压缩块时只出最热记忆，不产生空的「较早」区块", () => {
    // 分层判据是 hotStart>0，而 hotStart = max(0, len - COMPACT_BATCH_SIZE)。
    // 边界（恰好等于一块）与不足一块都必须落在「没有较早区块」这一侧，否则
    // 模型会收到一个标着「次要背景」的空段落。
    for (const count of [1, 2, COMPACT_BATCH_SIZE]) {
      const messages: BufferedMessage[] = Array.from({ length: count }, (_, index: number) => ({
        ...message,
        messageId: index + 1,
        id: index + 1,
        text: `消息 ${index + 1}`,
      }));
      const transcript: string = buildTieredVerbatimTranscript(messages);
      expect(transcript).not.toContain("【较早逐字记录（次要背景）】");
      expect(transcript).toContain(`【最热记忆（重要判断标准，最新最多 ${COMPACT_BATCH_SIZE} 条）】`);
      expect(transcript).toContain(`[message_id:${count}] [id:${count}] 千早 愛音：消息 ${count}`);
      // 逐行拼装不能在收尾多挂一个换行——转录按「一行 = 一条消息」读，
      // 空行会被当成一条空发言。
      expect(transcript.endsWith("\n")).toBe(false);
    }
  });

  test("空缓存也要给出可用转录：只有格式说明和空的最热区块，不抛也不留悬空换行", () => {
    // 逐行拼装换成按下标取值之后，空区间靠 Math.max(0, end - start) 兜底；
    // 这一条钉住它不会退化成异常或多余分隔符。
    const transcript: string = buildTieredVerbatimTranscript([]);
    expect(transcript).not.toContain("【较早逐字记录（次要背景）】");
    expect(transcript).toContain(`【最热记忆（重要判断标准，最新最多 ${COMPACT_BATCH_SIZE} 条）】`);
    expect(transcript.endsWith("\n")).toBe(true);
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
      replyChainLinkFixture({
        messageId: 81,
        id: 1,
        firstName: "Alice",
        lastName: "",
        username: "alice_dev",
        text: "第一跳原文",
        forwardedFrom: "频道 [id:-100666] 东京日报",
        snapshotOnly: false,
      }),
      replyChainLinkFixture({ messageId: 70, id: 2, firstName: "Bob", lastName: "", text: longText, snapshotOnly: true }),
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
      replyChainLinkFixture({ messageId: 81, id: 1, firstName: "Alice", lastName: "", text: "只有单跳", snapshotOnly: false }),
    ])).toBe("");
  });
});
