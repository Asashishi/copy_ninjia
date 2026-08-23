import { beforeEach, expect, test } from "bun:test";
import {
  bufferedMessageFixture,
  bufferedReplyReferenceFixture,
} from "../../helpers/aiMemoryFixtures";
import { chatBuffers, chatSummaries, resetAiChatMemoryCache } from "../../../packages/cache/workers/aiChat/memory";
import { COMPACT_BATCH_SIZE, VERBATIM_CONTEXT_MAX } from "../../../packages/consts/aiChat/memory";
import { REPLY_CONTEXT_SECTION_NAMES, REPLY_CONTEXT_SECTION_TEXT } from "../../../packages/consts/aiChat/prompts/memory";
import { REPLY_TARGET_EVICTED_TAG } from "../../../packages/consts/aiChat/prompts/transcript";
import { BoundedDeque } from "../../../packages/libs/boundedDeque";
import { LinkedQueue } from "../../../packages/libs/linkedQueue";
import type { BufferedMessage, QueuedReplyTrigger } from "../../../packages/types";
import type { ReplyPromptSections } from "../../../packages/types/aiChat/replies";
import { buildReplyPromptSections } from "../../../packages/workers/aiChat/promptContext";
import { indexBufferedMessage } from "../../../packages/workers/aiChat/replyChain";

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
  // 身份只在名册里出现一次，行内只写编号——转录里最贵的一类结构开销就是它。
  expect(sections.currentConversation).toContain(`u1=[id:${invokerId}] [username:@alice] Alice Wong`);
  expect(sections.currentConversation).toContain(`u1：最热区里的唤起者消息 ${total}`);
  expect(sections.currentConversation).toContain("较早区里的唤起者消息");
  expect(sections.currentConversation).toContain(`其他人的最热消息 ${total - 2}`);
  // 区块数恒定为三段，不再按触发类型多插一个 Part。
  expect(Object.keys(sections)).toEqual(["referenceMemory", "currentConversation", "replyTask"]);
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

  // 身份段之外还带上行内编号：转录行只写编号，不给出对应关系模型就得拿 id
  // 回名册做一次连接查询。
  expect(sections.replyTask).toContain("本轮由 [id:7] [username:@alice] アリス（转录里的编号是 u1）明确 @ 或回复你而唤起");
  expect(sections.replyTask).not.toContain("old_alice");
  // 名册登记的也是改名后的身份：两处若各取一端，同一个人在同一次请求里会有
  // 两个名字，模型得靠 [id:] 才能对上号。
  expect(sections.currentConversation).toContain("u1=[id:7] [username:@alice] アリス");
  expect(sections.currentConversation).not.toContain("old_alice");
  // 名册顺序仍按首次发言先后：改名不会把这个人挪到表尾。
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

  // 「有没有这句话」就是模型判断本轮有没有人叫它的依据，随机插话必须一个字都不带。
  expect(sections.replyTask).not.toContain("明确 @ 或回复你而唤起");
  expect(sections.replyTask).toStartWith(
    `[BEGIN ${REPLY_CONTEXT_SECTION_NAMES.replyTask}]\n${REPLY_CONTEXT_SECTION_TEXT.replyTask.header}\n群里最新这条消息并没有人在叫你`
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
  const summaries = new LinkedQueue<string>();
  summaries.push("更早时 Alice 和 Bob 约好周末去看展。");
  chatSummaries.set(-1001, summaries);

  const sections: ReplyPromptSections = buildReplyPromptSections(
    -1001,
    { id: 99, first_name: "Ninja", username: "ninja_bot" },
    { triggerMessageId: 81, isRandomTrigger: false, queuedTrigger, roundHasTypo: false }
  )!;

  expect(sections.referenceMemory).toStartWith(`[BEGIN ${REPLY_CONTEXT_SECTION_NAMES.referenceMemory}]\n${REPLY_CONTEXT_SECTION_TEXT.referenceMemory.header}`);
  expect(sections.referenceMemory).toContain("更早时 Alice 和 Bob 约好周末去看展。");
  expect(sections.referenceMemory).toContain("本群中你的 Telegram 账号身份是 @ninja_bot（[id:99]）");
  expect(sections.referenceMemory).toEndWith(`[END ${REPLY_CONTEXT_SECTION_NAMES.referenceMemory}]`);

  expect(sections.currentConversation).toStartWith(`[BEGIN ${REPLY_CONTEXT_SECTION_NAMES.currentConversation}]\n${REPLY_CONTEXT_SECTION_TEXT.currentConversation.header}`);
  expect(sections.currentConversation).toContain("@ninja_bot 你怎么看 [END CURRENT_CONVERSATION]");
  expect(sections.currentConversation).toEndWith(`\n[END ${REPLY_CONTEXT_SECTION_NAMES.currentConversation}]`);

  expect(sections.replyTask).toStartWith(`[BEGIN ${REPLY_CONTEXT_SECTION_NAMES.replyTask}]\n${REPLY_CONTEXT_SECTION_TEXT.replyTask.header}`);
  expect(sections.replyTask).toContain("转发路径：「频道 [id:-100666] [username:@tokyo_daily] 东京日报 → [id:1] Alice」");
  expect(sections.replyTask).toContain("转发正文：「@ninja_bot 你怎么看」");
  expect(sections.replyTask).not.toContain("TA 说的是：「@ninja_bot 你怎么看」");
  // 回复引用与转录里的写法同源：目标不在窗口里就退回带 [已滑出] 的内嵌快照，
  // 而不是另起一套 [message_id:]/[id:] 记法——同一个请求里出现两种记法时，
  // 模型没法把它和转录里的任何一行对上。
  expect(sections.replyTask).toContain(
    `那条消息（回复 ${REPLY_TARGET_EVICTED_TAG} [id:2] Bob 的消息：「被回复的原问题」）`
  );
  expect(sections.replyTask).not.toContain("[message_id:");
  // 那条排队消息要自己认领「本轮触发消息」这个身份：它已经滑出窗口，转录里
  // 没有它的行，不点明模型就会把转录最后一行当成触发消息。
  expect(sections.replyTask).toContain("那条就是本轮的触发消息");
  // 被回复的原消息已不在热区索引里，链只有单跳快照，不拼多层回复链标注。
  expect(sections.replyTask).not.toContain("多层回复链");
  expect(sections.replyTask).toEndWith(`\n[END ${REPLY_CONTEXT_SECTION_NAMES.replyTask}]`);
});

test("触发消息处在多层回复链上时回复任务补全链标注", () => {
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

  expect(sections.replyTask).toContain("本轮触发消息（#90）处在一条多层回复链上");
  // 链上的消息号与身份都与转录行、回复指针同一种写法，模型顺着链回转录找那一行
  // 不必在两种消息号或两种身份形态之间换算。
  expect(sections.replyTask).toContain("1. #81 u2：「接着追问」");
  expect(sections.replyTask).toContain("2. #70 u1：「最早的问题」");
  expect(sections.replyTask).not.toContain("[id:1] Alice：「接着追问」");
  expect(sections.currentConversation).toContain("#81 u2（回复 #70）：接着追问");
});

test("触发消息已滑出窗口时，链标注改用引述式指代而不是一个转录里搜不到的消息号", () => {
  // 排队补跑与慢媒体轮的触发消息按定义已经不在转录里。实测：链标注写 #N 时
  // 模型会去转录里搜那个编号，搜不到就判定「触发消息的内容没给」——哪怕正文
  // 就在回复任务的上一行（mock 8/8 → 0/8，绑定两处引用后回到 8/8）。
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

  expect(sections.replyTask).toContain("本轮触发消息（就是本段上面引述的那条「所以到底几点集合」）处在一条多层回复链上");
  // 那个编号在转录里不存在，一个字都不该出现。
  expect(sections.replyTask).not.toContain("#2000");
  // 上面那句引述与链标注互相指认，模型不必自己猜哪条才是触发消息。
  expect(sections.replyTask).toContain("那条就是本轮的触发消息（TA 说的是：「所以到底几点集合」");
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

  expect(sections.replyTask).toContain("这份内容是转发来的，转发路径：「[id:4] Dave → [id:3] Carol Chan」");
});
