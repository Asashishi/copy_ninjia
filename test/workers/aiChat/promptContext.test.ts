import { beforeEach, expect, test } from "bun:test";
import {
  bufferedMessageFixture,
  bufferedReplyReferenceFixture,
} from "../../helpers/aiMemoryFixtures";
import { chatBuffers, chatSummaries, resetAiChatMemoryCache } from "../../../packages/cache/workers/aiChat/memory";
import { COMPACT_BATCH_SIZE, MAX_SUMMARY_ROUNDS, TRANSCRIPT_SETTLED_SEGMENT_SIZE, VERBATIM_CONTEXT_MAX } from "../../../packages/consts/aiChat/memory";
import {
  REPLY_CONTEXT_SECTION_NAMES,
  REPLY_CONTEXT_SECTION_TEXT,
  directInvokerSentence,
} from "../../../packages/consts/aiChat/prompts/memory";
import { expectTemplateRendered, longestTemplatePart } from "../../helpers/templateText";
import {
  RANDOM_TRIGGER_INSTRUCTION,
  forwardedMediaNotice,
  mediaNounFor,
  mediaReplyTriggerInstruction,
  queuedTriggerDescription,
  selfIdentityStatement,
} from "../../../packages/consts/aiChat/prompts/replyTask";
import { TOOL_STATUS_BLOCK_LABEL, VOICE_LANGUAGE_PROMPTS } from "../../../packages/consts/aiChat/prompts/tools";
import {
  REPLY_TARGET_EVICTED_TAG,
  forwardPathTemplate,
  replyPointerTemplate,
  replyTagTemplate,
} from "../../../packages/consts/aiChat/prompts/transcript";
import { BoundedDeque } from "../../../packages/libs/boundedDeque";
import type { BufferedMessage } from "../../../packages/types/aiChat/memory";
import type { QueuedReplyTrigger, ReplyPromptSections } from "../../../packages/types/aiChat/replies";
import { buildReplyPromptSections } from "../../../packages/workers/aiChat/promptContext";
import { indexBufferedMessage } from "../../../packages/workers/aiChat/bufferedMessageIndex";

beforeEach(resetAiChatMemoryCache);

test("直接唤起在回复任务开头声明唤起者完整身份，不再另拼一份 TA 的热发言", () => {
  const invokerId: number = 7;
  const otherId: number = 8;
  const messages = new BoundedDeque<BufferedMessage>(VERBATIM_CONTEXT_MAX);
  const total: number = COMPACT_BATCH_SIZE + 2;
  for (let index: number = 0; index < total; index++) {
    const messageId: number = index + 1;
    const isEarlierInvoker: boolean = messageId === 1;
    const isHotInvoker: boolean = messageId === total - 1 || messageId === total;
    const isInvoker: boolean = isEarlierInvoker || isHotInvoker;
    const message: BufferedMessage = bufferedMessageFixture({
      messageId,
      id: isInvoker ? invokerId : otherId,
      firstName: isInvoker ? "Alice" : "Bob",
      lastName: isInvoker ? "Wong" : "",
      username: isInvoker ? "alice" : undefined,
      text: isEarlierInvoker
        ? "较早区里的唤起者消息"
        : isHotInvoker
        ? `最热区里的唤起者消息 ${messageId}`
        : `其他人的最热消息 ${messageId}`,
      at: `2026/07/30 12:00:${String(index).padStart(2, "0")}`,
    });
    messages.push(message);
    indexBufferedMessage(-1001, message);
  }
  chatBuffers.set(-1001, messages);

  const sections: ReplyPromptSections = buildReplyPromptSections(
    -1001,
    { id: 99, first_name: "Ninja", username: "ninja_bot" },
    {
      triggerMessageId: total,
      directInvokerId: invokerId,
      isRandomTrigger: false,
      roundHasTypo: false,
    }
  )!;

  // 身份段与转录行、回复标注里同一个人的写法逐字同形（[id:]、[username:@]、显示名）。
  expect(sections.replyTask).toStartWith(
    `[BEGIN ${REPLY_CONTEXT_SECTION_NAMES.replyTask}]\n${REPLY_CONTEXT_SECTION_TEXT.replyTask.header}\n` +
    `本轮由 [id:${invokerId}] [username:@alice] Alice Wong（转录里的编号是 u1）明确 @ 或回复你而唤起。\n`
  );
  // 唤起者的发言只在完整转录里出现一次，回复任务不再复制一份。
  expect(sections.replyTask).not.toContain(`最热区里的唤起者消息 ${total}`);
  expect(sections.replyTask).not.toContain("较早区里的唤起者消息");
  // 身份只在名册里出现一次，行内只写编号。
  expect(sections.currentConversation).toContain(`u1=[id:${invokerId}] [username:@alice] Alice Wong`);
  expect(sections.currentConversation).toContain(`u1：最热区里的唤起者消息 ${total}`);
  expect(sections.currentConversation).toContain("较早区里的唤起者消息");
  expect(sections.currentConversation).toContain(`其他人的最热消息 ${total - 2}`);
  // 区块集合固定，不随触发类型增减 Part；转录已定切点另列一项。
  expect(Object.keys(sections)).toEqual(["referenceMemory", "currentConversation", "currentConversationSettledOffsets", "replyTask"]);
  // 切点平移到当前会话区块内：最新消息所在格之前每格一个，紧跟上一格最后一条正文。
  const transcriptStart: number = sections.currentConversation.indexOf("\n", sections.currentConversation.indexOf(
    REPLY_CONTEXT_SECTION_TEXT.currentConversation.header
  )) + 1;
  expect(sections.currentConversationSettledOffsets).toHaveLength(Math.floor((total - 1) / TRANSCRIPT_SETTLED_SEGMENT_SIZE));
  for (const offset of sections.currentConversationSettledOffsets) {
    expect(offset).toBeGreaterThan(transcriptStart);
    expect(sections.currentConversation[offset]).toBe("\n");
  }
  expect(sections.currentConversation.slice(0, sections.currentConversationSettledOffsets[0]))
    .toEndWith(`其他人的最热消息 ${TRANSCRIPT_SETTLED_SEGMENT_SIZE}`);
  // 跨任务相同的行动总则只在 system prompt 出现，动态任务只保留触发语义。
  for (const prompts of Object.values(VOICE_LANGUAGE_PROMPTS)) {
    expect(sections.replyTask).not.toContain(prompts.replyActionInstruction);
  }
  // 按轮变化的工具状态只在运行时状态区块，回复任务里没有。
  expect(sections.replyTask).not.toContain(TOOL_STATUS_BLOCK_LABEL);
  expect(sections.replyTask).toEndWith(`[END ${REPLY_CONTEXT_SECTION_NAMES.replyTask}]`);
});

test("触发消息已不在热区索引时，唤起者身份从逐字缓存里取最近一条回填", () => {
  const messages = new BoundedDeque<BufferedMessage>(VERBATIM_CONTEXT_MAX);
  messages.push(bufferedMessageFixture({
    messageId: 1,
    id: 7,
    firstName: "Alice",
    lastName: "",
    username: "old_alice",
    text: "改名之前说的话",
    at: "2026/07/30 11:00:00",
  }));
  messages.push(bufferedMessageFixture({
    messageId: 2,
    id: 7,
    firstName: "アリス",
    lastName: "",
    username: "alice",
    text: "改名之后说的话",
    at: "2026/07/30 11:30:00",
  }));
  messages.push(bufferedMessageFixture({
    messageId: 3,
    id: 8,
    firstName: "Bob",
    lastName: "",
    text: "别人的最新一条",
    at: "2026/07/30 12:00:00",
  }));
  chatBuffers.set(-1001, messages);

  // 触发消息（排队补跑那类）本身已滑出索引，只能靠缓存里 TA 最近的一条回填。
  const sections: ReplyPromptSections = buildReplyPromptSections(
    -1001,
    { id: 99, first_name: "Ninja", username: "ninja_bot" },
    { triggerMessageId: 999, directInvokerId: 7, isRandomTrigger: false, roundHasTypo: false }
  )!;

  // 身份段之外还带上行内编号，与转录行的编号对应。
  expect(sections.replyTask).toContain("本轮由 [id:7] [username:@alice] アリス（转录里的编号是 u1）明确 @ 或回复你而唤起");
  expect(sections.replyTask).not.toContain("old_alice");
  // 名册登记的是改名后的身份，与回复任务里的写法一致。
  expect(sections.currentConversation).toContain("u1=[id:7] [username:@alice] アリス");
  expect(sections.currentConversation).not.toContain("old_alice");
  // 名册顺序按首次发言先后，改名不改变位置。
  expect(sections.currentConversation.indexOf("u1=")).toBeLessThan(sections.currentConversation.indexOf("u2="));
});

test("唤起者整段逐字缓存里都没有时只报 id，不拿别人的名字凑", () => {
  const messages = new BoundedDeque<BufferedMessage>(VERBATIM_CONTEXT_MAX);
  messages.push(bufferedMessageFixture({
    messageId: 1,
    id: 8,
    firstName: "Bob",
    lastName: "",
    username: "bob",
    text: "缓存里只有 Bob",
    at: "2026/07/30 12:00:00",
  }));
  chatBuffers.set(-1001, messages);

  const sections: ReplyPromptSections = buildReplyPromptSections(
    -1001,
    { id: 99, first_name: "Ninja", username: "ninja_bot" },
    { triggerMessageId: 1, directInvokerId: 7, isRandomTrigger: false, roundHasTypo: false }
  )!;

  expect(sections.replyTask).toContain("本轮由 [id:7] 明确 @ 或回复你而唤起");
  expect(sections.replyTask).not.toContain("Bob");
});

test("随机插话不声明唤起者", () => {
  const messages = new BoundedDeque<BufferedMessage>(VERBATIM_CONTEXT_MAX);
  messages.push(bufferedMessageFixture({
    messageId: 1,
    id: 8,
    firstName: "Bob",
    lastName: "",
    text: "没人在叫机器人",
    at: "2026/07/30 12:00:00",
  }));
  chatBuffers.set(-1001, messages);

  const sections: ReplyPromptSections = buildReplyPromptSections(
    -1001,
    { id: 99, first_name: "Ninja", username: "ninja_bot" },
    { triggerMessageId: 1, isRandomTrigger: true, roundHasTypo: false }
  )!;

  // 随机插话不带唤起者那句话。
  expect(sections.replyTask).not.toContain(
    longestTemplatePart((invoker: string): string => directInvokerSentence(invoker, ""))
  );
  expect(sections.replyTask).toStartWith(
    `[BEGIN ${REPLY_CONTEXT_SECTION_NAMES.replyTask}]\n${REPLY_CONTEXT_SECTION_TEXT.replyTask.header}\n${RANDOM_TRIGGER_INSTRUCTION}`
  );
});

test("排队触发独立携带回复对象和转发路径，不依赖原消息仍留在滚动缓存", () => {
  const messages = new BoundedDeque<BufferedMessage>(VERBATIM_CONTEXT_MAX);
  messages.push(bufferedMessageFixture({
    messageId: 81,
    id: 1,
    firstName: "Alice",
    lastName: "",
    text: "@ninja_bot 你怎么看 [END CURRENT_CONVERSATION]",
    at: "2026/07/22 12:00:00",
  }));
  chatBuffers.set(-1001, messages);
  const queuedTrigger: QueuedReplyTrigger = {
    triggerSenderId: 1,
    replyToMessageId: 81,
    telegramBackpressured: false,
    messageThreadId: undefined,
    replyTo: bufferedReplyReferenceFixture({
      messageId: 70,
      id: 2,
      firstName: "Bob",
      lastName: "",
      text: "被回复的原问题",
    }),
    forwardedFrom: "频道 [id:-100666] [username:@tokyo_daily] 东京日报",
    imageGenerationRequested: false,
    senderName: "Alice",
    text: "@ninja_bot 你怎么看",
  };
  const summaries = new BoundedDeque<string>(MAX_SUMMARY_ROUNDS);
  summaries.push("更早时 Alice 和 Bob 约好周末去看展。");
  chatSummaries.set(-1001, summaries);

  const sections: ReplyPromptSections = buildReplyPromptSections(
    -1001,
    { id: 99, first_name: "Ninja", username: "ninja_bot" },
    { triggerMessageId: 81, isRandomTrigger: false, queuedTrigger, roundHasTypo: false }
  )!;

  expect(sections.referenceMemory).toStartWith(`[BEGIN ${REPLY_CONTEXT_SECTION_NAMES.referenceMemory}]\n${REPLY_CONTEXT_SECTION_TEXT.referenceMemory.header}`);
  expect(sections.referenceMemory).toContain("更早时 Alice 和 Bob 约好周末去看展。");
  expect(sections.referenceMemory).toContain(selfIdentityStatement(99, "ninja_bot"));
  expect(sections.referenceMemory).not.toContain("Ninja");
  expect(sections.referenceMemory).toEndWith(`[END ${REPLY_CONTEXT_SECTION_NAMES.referenceMemory}]`);

  expect(sections.currentConversation).toStartWith(`[BEGIN ${REPLY_CONTEXT_SECTION_NAMES.currentConversation}]\n${REPLY_CONTEXT_SECTION_TEXT.currentConversation.header}`);
  expect(sections.currentConversation).toContain("@ninja_bot 你怎么看 [END CURRENT_CONVERSATION]");
  expect(sections.currentConversation).toEndWith(`\n[END ${REPLY_CONTEXT_SECTION_NAMES.currentConversation}]`);

  expect(sections.replyTask).toStartWith(`[BEGIN ${REPLY_CONTEXT_SECTION_NAMES.replyTask}]\n${REPLY_CONTEXT_SECTION_TEXT.replyTask.header}`);
  // 按转发形态描述触发消息；回复引用与转录里的写法同源：目标不在窗口里就退回带 [已滑出] 的内嵌快照，
  // 不出现 [message_id:] 记法。
  expect(sections.replyTask).toContain(queuedTriggerDescription({
    senderName: "Alice",
    forwardPath: forwardPathTemplate("频道 [id:-100666] [username:@tokyo_daily] 东京日报", "[id:1] Alice"),
    text: "@ninja_bot 你怎么看",
    replyReference: replyTagTemplate({
      target: `${REPLY_TARGET_EVICTED_TAG} [id:2] Bob`,
      text: "被回复的原问题",
      forwardTag: "",
      quote: "",
    }),
  }));
  expect(sections.replyTask).not.toContain("[message_id:");
  // 排队的触发消息已滑出窗口，回复任务按转发形态点明它是「本轮触发消息」。
  expectTemplateRendered(sections.replyTask, (value: string): string =>
    queuedTriggerDescription({ senderName: value, forwardPath: value, text: value, replyReference: value }));
  // 原消息不在热区时只使用入队快照里的单跳引用。
  expect(sections.replyTask).not.toContain("多层回复链");
  expect(sections.replyTask).toEndWith(`\n[END ${REPLY_CONTEXT_SECTION_NAMES.replyTask}]`);
});

test("多层回复仅保留转录中的单跳关系、转发和精确引用", () => {
  const root: BufferedMessage = bufferedMessageFixture({
    messageId: 70,
    id: 2,
    firstName: "Bob",
    lastName: "",
    text: "最早的问题",
    at: "2026/07/22 11:58:00",
  });
  const middle: BufferedMessage = bufferedMessageFixture({
    messageId: 81,
    id: 1,
    firstName: "Alice",
    lastName: "",
    text: "接着追问",
    replyTo: bufferedReplyReferenceFixture({ messageId: 70, id: 2, firstName: "Bob", lastName: "", text: "最早的问题", quote: "最早" }),
    forwardedFrom: "东京日报",
    at: "2026/07/22 11:59:00",
  });
  const trigger: BufferedMessage = bufferedMessageFixture({
    messageId: 90,
    id: 3,
    firstName: "Carol",
    lastName: "",
    text: "@ninja_bot 你来评评理",
    replyTo: bufferedReplyReferenceFixture({ messageId: 81, id: 1, firstName: "Alice", lastName: "", text: "接着追问" }),
    at: "2026/07/22 12:00:00",
  });
  const messages = new BoundedDeque<BufferedMessage>(VERBATIM_CONTEXT_MAX);
  for (const entry of [root, middle, trigger]) {
    messages.push(entry);
    indexBufferedMessage(-1001, entry);
  }
  chatBuffers.set(-1001, messages);

  const sections: ReplyPromptSections = buildReplyPromptSections(
    -1001,
    { id: 99, first_name: "Ninja", username: "ninja_bot" },
    { triggerMessageId: 90, isRandomTrigger: false, roundHasTypo: false }
  )!;

  expect(sections.replyTask).not.toContain("多层回复链");
  expect(sections.replyTask).not.toContain("接着追问");
  expect(sections.replyTask).not.toContain("最早的问题");
  expect(sections.currentConversation).toContain("（回复 #70）");
  expect(sections.currentConversation).toContain("（回复 #81）");
  expect(sections.currentConversation).toContain("东京日报");
  expect(sections.currentConversation).toContain("（转发自 f1）");
  expect(sections.currentConversation).toContain("（精确引用片段：「最早」）");
});

test("排队触发滑出窗口后保留入队正文与单跳引用，不追加多层回复链", () => {
  const root: BufferedMessage = bufferedMessageFixture({
    messageId: 70,
    id: 2,
    firstName: "Bob",
    lastName: "",
    text: "最早的问题",
    at: "2026/07/22 11:58:00",
  });
  const middle: BufferedMessage = bufferedMessageFixture({
    messageId: 81,
    id: 1,
    firstName: "Alice",
    lastName: "",
    text: "接着追问",
    replyTo: bufferedReplyReferenceFixture({ messageId: 70, id: 2, firstName: "Bob", lastName: "", text: "最早的问题" }),
    at: "2026/07/22 11:59:00",
  });
  const messages = new BoundedDeque<BufferedMessage>(VERBATIM_CONTEXT_MAX);
  for (const entry of [root, middle]) {
    messages.push(entry);
    indexBufferedMessage(-1001, entry);
  }
  chatBuffers.set(-1001, messages);
  const queuedTrigger: QueuedReplyTrigger = {
    triggerSenderId: 3,
    replyToMessageId: 2000,
    telegramBackpressured: false,
    messageThreadId: undefined,
    replyTo: bufferedReplyReferenceFixture({ messageId: 81, id: 1, firstName: "Alice", lastName: "", text: "接着追问" }),
    forwardedFrom: undefined,
    imageGenerationRequested: false,
    senderName: "Carol",
    text: "所以到底几点集合",
  };

  const sections: ReplyPromptSections = buildReplyPromptSections(
    -1001,
    { id: 99, first_name: "Ninja", username: "ninja_bot" },
    { triggerMessageId: 2000, isRandomTrigger: false, queuedTrigger, roundHasTypo: false }
  )!;

  expect(sections.replyTask).not.toContain("多层回复链");
  // 该编号不出现在回复任务里。
  expect(sections.replyTask).not.toContain("#2000");
  // 任务保留触发时的正文，回复对象就在窗口里时只留指针。
  expect(sections.replyTask).toContain(queuedTriggerDescription({
    senderName: "Carol",
    forwardPath: "",
    text: "所以到底几点集合",
    replyReference: replyPointerTemplate(81),
  }));
});

test("媒体特殊回复任务明确标出来源到当前发送者的转发路径", () => {
  const messages = new BoundedDeque<BufferedMessage>(VERBATIM_CONTEXT_MAX);
  messages.push(bufferedMessageFixture({
    messageId: 82,
    id: 3,
    firstName: "Carol",
    lastName: "Chan",
    text: "[图片：夜景] @ninja_bot 看这个",
    forwardedFrom: "[id:4] Dave",
    at: "2026/07/22 12:01:00",
  }));
  chatBuffers.set(-1001, messages);

  const sections: ReplyPromptSections = buildReplyPromptSections(
    -1001,
    { id: 99, first_name: "Ninja", username: "ninja_bot" },
    {
      triggerMessageId: 82,
      isRandomTrigger: false,
      mediaComment: {
        kind: "photo",
        senderId: 3,
        senderName: "Carol Chan",
        description: "一张城市夜景",
        forwardedFrom: "[id:4] Dave",
        directTriggerReason: "mention",
      },
      roundHasTypo: false,
    }
  )!;

  expect(sections.replyTask).toContain(forwardedMediaNotice(forwardPathTemplate("[id:4] Dave", "[id:3] Carol Chan")));
});

test.each(["sticker", "animation", "voice", "photo"] as const)("媒体回复任务按类型 %s 给出对应名词", (kind) => {
  const messages = new BoundedDeque<BufferedMessage>(VERBATIM_CONTEXT_MAX);
  messages.push(bufferedMessageFixture({
    messageId: 83,
    id: 3,
    firstName: "Carol",
    text: "[媒体] 回复",
    at: "2026/07/22 12:02:00",
  }));
  chatBuffers.set(-1001, messages);

  const sections: ReplyPromptSections = buildReplyPromptSections(
    -1001,
    { id: 99, first_name: "Ninja", username: "ninja_bot" },
    {
      triggerMessageId: 83,
      isRandomTrigger: false,
      mediaComment: {
        kind,
        senderId: 3,
        senderName: "Carol",
        description: "内容描述",
        directTriggerReason: "reply",
      },
      roundHasTypo: false,
    }
  )!;

  expect(sections.replyTask).toContain(mediaNounFor(kind));
  expectTemplateRendered(sections.replyTask, (value: string): string =>
    mediaReplyTriggerInstruction({ kind, senderId: 3, senderName: value, description: value }, value));
});
