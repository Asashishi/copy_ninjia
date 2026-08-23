import { beforeEach, describe, expect, mock, test } from "bun:test";
import { CHAT_QA_MAX_PER_CHAT, QA_COMMAND_TEXTS } from "../../packages/consts/qa";

interface SentMessage {
  chatId: number;
  text: string;
  entities?: readonly { type: string; offset: number; length: number }[];
  preserveInGroup?: boolean;
  replyToMessageId?: number;
}

const sendCommandMessage = mock(async (_message: SentMessage): Promise<number | undefined> => 1);
// 与真实 sendMessage 同构：拿到 id 的同步时点回调 onSent，表单 id 才登记得上。
const sendMessage = mock(
  async (message: { onSent?: (id: number) => void }): Promise<number | undefined> => {
    message.onSent?.(55);
    return 55;
  }
);
const deleteMessageWithOutcome = mock(async (): Promise<unknown> => ({ deleted: true }));
const chatStates = new Map<number, { isInitEnabled?: boolean }>();
const permitted: Set<number> = new Set<number>();

mock.module("../../packages/infra/telegram", () => ({
  sendCommandMessage,
  sendMessage,
  deleteMessageWithOutcome,
  logApiError: (): void => {},
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getChatState: (chatId: number): { isInitEnabled?: boolean } => chatStates.get(chatId) ?? {},
  getQaThumbnailUrl: (): string => "https://example.invalid/qa.png",
}));
interface ActorContext {
  from?: { id: number };
  msg?: { sender_chat?: { id: number } };
}
mock.module("../../packages/commands/commandActor", () => ({
  // 与生产同构：sender_chat 优先于 from，并带上 isChannel 标记。
  resolveCommandActor: (
    ctx: ActorContext
  ): { id: number; isChannel?: boolean } | undefined => {
    const senderChat = ctx.msg?.sender_chat;
    if (senderChat !== undefined) return { id: senderChat.id, isChannel: true };
    return ctx.from === undefined ? undefined : { id: ctx.from.id };
  },
  hasCommandPermission: (ctx: ActorContext): boolean => {
    const senderChat = ctx.msg?.sender_chat;
    const id = senderChat?.id ?? ctx.from?.id;
    return id !== undefined && permitted.has(id);
  },
}));
mock.module("../../packages/users/userLabel", () => ({
  formatUserLabel: (user: { id: number }): string => `用户${user.id}`,
}));
mock.module("../../packages/infra/identityPolicy/whitelist", () => ({
  hasWhitelistPermission: (id: number): boolean => permitted.has(id),
}));

const {
  handleQaMessageIngress,
  handleQueryQaCommand,
  handleRemoveQaCommand,
  handleSetQaCommand,
} = await import("../../packages/commands/qa");
const { chatQaEntries, qaFormSessions, resetChatQaCache } =
  await import("../../packages/cache/main/qa");
const { renderQaInlineResult } = await import("../../packages/commands/qa/rendering");

const CHAT_ID: number = -1001;
const OWNER: number = 42;

interface ChatShape {
  id: number;
  type: string;
  title: string;
  is_forum?: true;
}

interface ContextOverrides {
  readonly chat?: ChatShape;
  readonly msg?: Record<string, unknown>;
}

function context(
  fromId: number | undefined,
  match: string,
  overrides: ContextOverrides = {}
): never {
  return {
    chat: overrides.chat ?? { id: CHAT_ID, type: "supergroup", title: "T" },
    msgId: 10,
    match,
    // grammY 的 CommandContext 恒带 msg；夹具此前只在覆写时才给，于是任何读
    // ctx.msg 的新代码（比如取论坛话题 id）在这里会撞上 undefined，而生产没有
    // 这个形态。始终给一份最小消息，再让覆写往上叠。
    msg: { message_id: 10, ...overrides.msg },
    ...(fromId === undefined ? {} : { from: { id: fromId } }),
  } as never;
}

/** 套着频道马甲发出的命令：Telegram 只给 sender_chat，看不见皮下是谁。 */
function channelContext(match: string): never {
  return {
    chat: { id: CHAT_ID, type: "supergroup", title: "T" },
    msgId: 10,
    match,
    from: { id: 1087968824 },
    msg: {
      message_id: 10,
      sender_chat: { id: -1009999, type: "channel", title: "皮套" },
    },
  } as never;
}

const BOT_ID: number = 999;

function landed(text: string): never {
  return {
    message_id: 77,
    date: 1,
    chat: { id: CHAT_ID, type: "supergroup", title: "T" },
    text,
    from: { id: OWNER, is_bot: false, first_name: "A" },
    via_bot: { id: BOT_ID, is_bot: true, first_name: "B" },
  } as never;
}

function lastText(): string {
  return sendCommandMessage.mock.calls.at(-1)?.[0].text ?? "";
}

beforeEach((): void => {
  sendCommandMessage.mockClear();
  sendMessage.mockClear();
  deleteMessageWithOutcome.mockClear();
  chatStates.clear();
  chatStates.set(CHAT_ID, { isInitEnabled: true });
  permitted.clear();
  permitted.add(OWNER);
  resetChatQaCache();
});

describe("/set_qa", () => {
  test("未接管的群一律拒绝，三条命令同一句", async () => {
    chatStates.set(CHAT_ID, {});

    await handleSetQaCommand(context(OWNER, ""));
    await handleQueryQaCommand(context(OWNER, ""));
    await handleRemoveQaCommand(context(OWNER, "x"));

    expect(sendCommandMessage).toHaveBeenCalledTimes(3);
    for (const call of sendCommandMessage.mock.calls) {
      expect(call[0].text).toBe(QA_COMMAND_TEXTS.notInitialized);
    }
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("频道马甲一律拒绝：看不见皮下是谁，也用不了 inline", async () => {
    permitted.add(-1009999);

    await handleSetQaCommand(channelContext(""));
    expect(lastText()).toBe(QA_COMMAND_TEXTS.channelActor);
    expect(qaFormSessions.size).toBe(0);

    // 即使那张皮本身持有权限也不放行。
    await handleRemoveQaCommand(channelContext("怎么入群？"));
    expect(lastText()).toBe(QA_COMMAND_TEXTS.channelActor);
  });

  test("没有 isCanControllQaPermission 的身份拿不到表单", async () => {
    await handleSetQaCommand(context(7, ""));

    expect(lastText()).toContain("isCanControllQaPermission");
    expect(qaFormSessions.size).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("获授权者拿到一张两按钮表单，会话按 (群, 发起人) 建立", async () => {
    await handleSetQaCommand(context(OWNER, ""));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(qaFormSessions.get(CHAT_ID)).toBeDefined();
  });

  test("话题群里 General 与其它话题一样发表单", async () => {
    const forum: ChatShape = { id: CHAT_ID, type: "supergroup", title: "T", is_forum: true };

    // General 也是话题栏里一个正常话题，内联在那里可用。曾经按
    // `is_topic_message !== true` 把它当成不可用而挡掉——那个判据立不住：
    // General 的消息与「全部」聚合视图发出的消息在 bot 侧完全无法区分，
    // 真正不可用的只有后者，而它不带任何可判别的标记。
    await handleSetQaCommand(context(OWNER, "", { chat: forum }));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(qaFormSessions.get(CHAT_ID)).toBeDefined();
    // General 不带 message_thread_id：Bot API 里「没有话题」与 General 同义。
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ messageThreadId: undefined });

    sendMessage.mockClear();
    await handleSetQaCommand(context(OWNER, "", {
      chat: forum,
      msg: { is_topic_message: true, message_thread_id: 77 },
    }));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    // 表单由状态机而非 30 秒清理持有，会一直留到填齐/超时/teardown，因此必须
    // 自己带话题：只靠 reply_parameters 的话，命令消息被删就掉进 General。
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ messageThreadId: 77 });
  });

  test("已满 5 条时不开表单，先让人去删", async () => {
    const entries = new Map<string, string>();
    for (let index: number = 0; index < CHAT_QA_MAX_PER_CHAT; index++) {
      entries.set(`问题${index}`, "答案");
    }
    chatQaEntries.set(CHAT_ID, entries);

    await handleSetQaCommand(context(OWNER, ""));

    expect(lastText()).toBe(QA_COMMAND_TEXTS.full);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("/query_qa", () => {
  test("一条都没有时如实说空，且不是长期保留的看板", async () => {
    await handleQueryQaCommand(context(7, ""));

    expect(lastText()).toBe(QA_COMMAND_TEXTS.queryEmpty);
    expect(sendCommandMessage.mock.calls.at(-1)?.[0].preserveInGroup).toBeUndefined();
  });

  test("不带参数列全部，按 JSON 代码块长期保留", async () => {
    chatQaEntries.set(CHAT_ID, new Map([["a", "1"], ["b", "2"]]));

    // 群成员都能查：这里故意用一个没有维护权限的身份。
    await handleQueryQaCommand(context(7, ""));

    const sent: SentMessage = sendCommandMessage.mock.calls.at(-1)![0];
    expect(sent.preserveInGroup).toBeTrue();
    const entity = sent.entities![0]!;
    expect(JSON.parse(sent.text.slice(entity.offset, entity.offset + entity.length)))
      .toEqual([{ q: "a", a: "1" }, { q: "b", a: "2" }]);
  });

  test("带参数只查那一条，返回规格里那个对象形状", async () => {
    chatQaEntries.set(CHAT_ID, new Map([["怎么入群？", "点置顶"]]));

    await handleQueryQaCommand(context(7, "怎么入群？"));

    const sent: SentMessage = sendCommandMessage.mock.calls.at(-1)![0];
    const entity = sent.entities![0]!;
    expect(JSON.parse(sent.text.slice(entity.offset, entity.offset + entity.length)))
      .toEqual({ q: "怎么入群？", a: "点置顶" });
  });

  test("查不到那条时点名它，并走默认 30 秒清理", async () => {
    chatQaEntries.set(CHAT_ID, new Map([["怎么入群？", "点置顶"]]));

    await handleQueryQaCommand(context(7, "不存在的"));

    expect(lastText()).toBe(QA_COMMAND_TEXTS.queryMissing("不存在的"));
    expect(sendCommandMessage.mock.calls.at(-1)?.[0].preserveInGroup).toBeUndefined();
  });
});

describe("/remove_qa", () => {
  test("缺参数时给用法", async () => {
    await handleRemoveQaCommand(context(OWNER, ""));

    expect(lastText()).toBe(QA_COMMAND_TEXTS.removeUsage);
  });

  test("没有权限的身份删不掉", async () => {
    chatQaEntries.set(CHAT_ID, new Map([["怎么入群？", "点置顶"]]));

    await handleRemoveQaCommand(context(7, "怎么入群？"));

    expect(lastText()).toContain("isCanControllQaPermission");
    expect(chatQaEntries.get(CHAT_ID)?.has("怎么入群？")).toBeTrue();
  });

  test("回执如实：删到了说删了，没删到说本来就没有", async () => {
    chatQaEntries.set(CHAT_ID, new Map([["怎么入群？", "点置顶"]]));

    await handleRemoveQaCommand(context(OWNER, "不存在的"));
    expect(lastText()).toBe(QA_COMMAND_TEXTS.removeMissing("不存在的"));

    await handleRemoveQaCommand(context(OWNER, "怎么入群？"));
    expect(lastText()).toBe(QA_COMMAND_TEXTS.removed("怎么入群？"));
    expect(chatQaEntries.has(CHAT_ID)).toBeFalse();
  });
});

describe("表单填齐后的结算", () => {
  test("只填一项时留着表单，回执说明已记下哪一项", async () => {
    await handleSetQaCommand(context(OWNER, ""));
    sendCommandMessage.mockClear();

    const claimed: boolean = await handleQaMessageIngress(
      landed(renderQaInlineResult("q", "怎么入群？")),
      BOT_ID
    );

    expect(claimed).toBeTrue();
    expect(lastText()).toBe(QA_COMMAND_TEXTS.questionSaved);
    // 还差一项，会话必须留着。
    expect(qaFormSessions.get(CHAT_ID)).toBeDefined();
    expect(chatQaEntries.has(CHAT_ID)).toBeFalse();
  });

  test("两项齐了就落库、收走表单，并按新增/覆盖如实回执", async () => {
    await handleSetQaCommand(context(OWNER, ""));
    await handleQaMessageIngress(landed(renderQaInlineResult("q", "怎么入群？")), BOT_ID);
    sendCommandMessage.mockClear();

    await handleQaMessageIngress(landed(renderQaInlineResult("a", "点置顶")), BOT_ID);

    expect(lastText()).toBe(QA_COMMAND_TEXTS.created);
    // 话题群里 bot 主动发的消息没有回复目标就会落进 General，而表单在话题里。
    expect(sendCommandMessage.mock.calls.at(-1)?.[0].replyToMessageId).toBe(55);
    expect(chatQaEntries.get(CHAT_ID)?.get("怎么入群？")).toBe("点置顶");
    // 结算之后表单会话与按钮消息都不该再留着。
    expect(qaFormSessions.get(CHAT_ID)).toBeUndefined();
    expect(deleteMessageWithOutcome).toHaveBeenCalled();
  });

  test("覆盖同一问题时回执说覆盖，不谎称新增", async () => {
    chatQaEntries.set(CHAT_ID, new Map([["怎么入群？", "旧答案"]]));
    await handleSetQaCommand(context(OWNER, ""));
    await handleQaMessageIngress(landed(renderQaInlineResult("q", "怎么入群？")), BOT_ID);
    sendCommandMessage.mockClear();

    await handleQaMessageIngress(landed(renderQaInlineResult("a", "新答案")), BOT_ID);

    expect(lastText()).toBe(QA_COMMAND_TEXTS.replaced);
    expect(chatQaEntries.get(CHAT_ID)?.get("怎么入群？")).toBe("新答案");
  });

  test("没有表单的消息不认领，交回下游流水线", async () => {
    expect(await handleQaMessageIngress(landed(renderQaInlineResult("q", "x")), BOT_ID))
      .toBeFalse();
  });
});
