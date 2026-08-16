/**
 * AI 回复链路上的四条场景：逐字缓存条目构造、整段转录渲染、回复引用解析与提及判定。
 *
 * 与 scenarios.ts 分开：四条共用同一批 AI 记录夹具（RECORD_SOURCES/RECORD_TEXTS），
 * 而它们量的都是 aiChat 那一侧的读写形状，与容器/时间窗那批叶子场景无关。
 */

import type { Message } from "@grammyjs/types";
import {
  buildTieredVerbatimTranscript,
} from "../../../packages/aiChat/ai/utils/chatTranscript";
import type { TieredTranscriptOptions } from "../../../packages/aiChat/ai/utils/chatTranscript";
import { resolveMentionFacts, resolveReplyReference } from "../../../packages/auto/message/facts";
import type { BufferedMessage } from "../../../packages/types/aiChat/memory";
import type { AiRecordContext } from "../../../packages/types/aiChat/protocol";
import type { MentionFacts } from "../../../packages/types/auto";
import { buildBufferedMessage } from "../../../packages/workers/aiChat/bufferedMessage";
import { BENCHMARK_CHAT_ID, BENCHMARK_EPOCH_MS } from "./fixtures";
import type { Scenario } from "./types";

/**
 * 一条 AI 记录进入逐字缓存时的构造成本（workers/aiChat/bufferedMessage.ts）。
 *
 * 输入刻意混合四种「可选字段有没有」的组合：生产上正是这种混合让条件展开写法
 * 分裂出多个隐藏类。定形之后本场景量的是同一份工作在单一形状下的成本。
 */
const RECORD_SOURCES: readonly AiRecordContext[] = [
  {
    chatId: BENCHMARK_CHAT_ID, senderId: 101, firstName: "Alice", lastName: "Chen",
    username: "alice_dev", messageId: 1, replyTo: undefined, forwardedFrom: undefined,
    persistImmediately: false,
  },
  {
    chatId: BENCHMARK_CHAT_ID, senderId: 102, firstName: "Bob", lastName: "",
    username: undefined, messageId: 2, replyTo: undefined,
    forwardedFrom: "频道 [id:-100666] 东京日报", persistImmediately: false,
  },
  {
    chatId: BENCHMARK_CHAT_ID, senderId: 103, firstName: "Carol", lastName: "T",
    username: "carol", messageId: 3,
    replyTo: {
      messageId: 2, id: 102, firstName: "Bob", lastName: "", username: undefined,
      text: "被回复的原文", quote: undefined, forwardedFrom: undefined,
    },
    forwardedFrom: undefined, persistImmediately: false,
  },
  {
    chatId: BENCHMARK_CHAT_ID, senderId: 104, firstName: "Dave", lastName: "",
    username: undefined, messageId: 4, replyTo: undefined, forwardedFrom: undefined,
    persistImmediately: false,
  },
];

const RECORD_TEXTS: readonly string[] = [
  "今天天气不错", "在吗 有人吗", "哈哈哈哈哈", "这个功能怎么用",
];

export function bufferedMessageBuildScenario(): Scenario {
  return {
    iterations: 500_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        const source: AiRecordContext = RECORD_SOURCES[index % RECORD_SOURCES.length]!;
        const entry: BufferedMessage | null = buildBufferedMessage(
          source,
          RECORD_TEXTS[index % RECORD_TEXTS.length]!,
          BENCHMARK_EPOCH_MS + index
        );
        checksum += entry === null ? 0 : entry.text.length;
      }
      return checksum;
    },
    probes: { buildBufferedMessage },
  };
}

/**
 * 一次 AI 回复要付的转录渲染：把整条热区（上限 COMPACT_BATCH_SIZE 档，这里取
 * 生产同量级的 150 条）逐行拼成提示词。
 *
 * 这是 BufferedMessage 形状是否稳定的**读取侧**。缓存在场景构造时建好，采样
 * 只量渲染，不把构造成本混进来。
 *
 * **实测定形之后这条读数没有变化**（定形前 88.9~93.8k，定形后 89.9~91.0k，
 * 各 3~4 次独立进程，区间完全重叠），如实记在这里免得后来者据形状理论推断
 * 出一个并不存在的收益：这段的成本压倒性地在拼串本身，属性读取那点差异淹没
 * 在里面。定形真正的收益在构造侧（见 buffered-message-build）。本场景保留的
 * 意义是当**回归哨兵**——转录渲染是每次 AI 回复的必经之地。
 */
export function transcriptRenderScenario(): Scenario {
  const messages: BufferedMessage[] = [];
  for (let index: number = 0; index < 150; index += 1) {
    // message_id 逐条递增，与生产同形：RECORD_SOURCES 里那四个 id 循环用下去
    // 会让整段窗口只有四个不同的编号，而渲染侧要按 message_id 去重（同一条
    // update 被重投、快照 hydrate 各记一份），夹具一重复就把 150 条压成 4 条，
    // 这条哨兵量的就不再是生产那次渲染了。
    const source: AiRecordContext = {
      ...RECORD_SOURCES[index % RECORD_SOURCES.length]!,
      messageId: index + 1,
    };
    const entry: BufferedMessage | null = buildBufferedMessage(
      source,
      RECORD_TEXTS[index % RECORD_TEXTS.length]!,
      BENCHMARK_EPOCH_MS + index
    );
    if (entry !== null) messages.push(entry);
  }
  // 与生产同形的一次调用：机器人自己也在窗口里（拿固定编号），触发消息是最后一条。
  const options: TieredTranscriptOptions = {
    selfId: RECORD_SOURCES[0]!.senderId,
    triggerMessageId: messages[messages.length - 1]!.messageId,
  };
  return {
    iterations: 20_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        checksum += buildTieredVerbatimTranscript(messages, options).text.length;
      }
      return checksum;
    },
    probes: { buildTieredVerbatimTranscript },
  };
}

/** 带回复的消息每条都要解析一次回复引用（auto/message/facts.ts）。 */
export function replyReferenceScenario(): Scenario {
  const chat: Message["chat"] = {
    id: BENCHMARK_CHAT_ID, type: "supergroup", title: "Performance fixture",
  };
  // grammY 的 reply_to_message 用的是不可再嵌套的 ReplyMessage，显式标注它，
  // 别让 Message 的自嵌套字段污染这份 fixture 的类型。
  const replied: NonNullable<Message["reply_to_message"]> = {
    message_id: 40, date: 1, chat,
    from: { id: 456, is_bot: false, first_name: "Bob", username: "bob_dev" },
    text: "被回复的原文",
    reply_to_message: undefined,
  };
  const messages: readonly Message[] = [
    { message_id: 41, date: 1, chat, from: { id: 123, is_bot: false, first_name: "Alice" }, text: "回复一句", reply_to_message: replied },
    { message_id: 42, date: 1, chat, from: { id: 123, is_bot: false, first_name: "Alice" }, text: "带引用", reply_to_message: replied, quote: { text: "原文", position: 0, is_manual: true } },
    { message_id: 43, date: 1, chat, from: { id: 123, is_bot: false, first_name: "Alice" }, text: "没有回复" },
  ];
  return {
    iterations: 500_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        checksum += resolveReplyReference(messages[index % messages.length]!)?.text.length ?? 0;
      }
      return checksum;
    },
    probes: { resolveReplyReference },
  };
}

/**
 * 提及判定。两个变体分开量：`mention-facts` 混入带 entity 的消息（真正扫实体
 * 表那条路），`mention-facts-plain` 全是无 entity 的普通消息（生产上占绝大多数，
 * 量的是早退成本）。
 */
export function mentionFactsScenario(withEntities: boolean): Scenario {
  const chat: Message["chat"] = {
    id: BENCHMARK_CHAT_ID, type: "supergroup", title: "Performance fixture",
  };
  const plain: readonly Message[] = [
    { message_id: 1, date: 1, chat, text: "今天天气不错" },
    { message_id: 2, date: 1, chat, text: "在吗" },
    { message_id: 3, date: 1, chat, text: "这个怎么弄呢" },
  ];
  const mentioned: Message = {
    message_id: 4, date: 1, chat,
    text: "@tensai_bot 你怎么看 @someone_else",
    entities: [
      { type: "mention", offset: 0, length: 11 },
      { type: "mention", offset: 15, length: 14 },
    ],
  };
  const messages: readonly Message[] = withEntities
    ? [plain[0]!, plain[1]!, mentioned, plain[2]!]
    : plain;
  return {
    iterations: 1_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        const facts: MentionFacts = resolveMentionFacts(
          messages[index % messages.length]!, 4242, "tensai_bot"
        );
        if (facts.isMentioned) checksum += 1;
        if (facts.hasOtherMention) checksum += 2;
      }
      return checksum;
    },
    probes: { resolveMentionFacts },
  };
}
