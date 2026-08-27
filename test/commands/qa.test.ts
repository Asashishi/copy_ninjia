import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  CHAT_QA_MAX_PER_CHAT,
  CHAT_QA_QUESTION_MAX_CHARS,
  QA_COMMAND_TEXTS,
  QA_FORM_SESSION_MAX,
} from "../../packages/consts/qa";

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
const answerCallbackQuery = mock(async (): Promise<void> => {});

/** 表单就地改写的入参；只断言领域关心的三项。 */
interface EditedMessage {
  chatId: number;
  messageId: number;
  text: string;
}
const editMessageText = mock(async (_message: EditedMessage): Promise<boolean> => true);
const chatStates = new Map<number, { isInitEnabled?: boolean }>();
const permitted: Set<number> = new Set<number>();

mock.module("../../packages/infra/telegram", () => ({
  sendCommandMessage,
  sendMessage,
  deleteMessageWithOutcome,
  answerCallbackQuery,
  editMessageText,
  logApiError: (): void => {},
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getChatState: (chatId: number): { isInitEnabled?: boolean } => chatStates.get(chatId) ?? {},
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
const { renderQaFormPrompt } = await import("../../packages/commands/qa/rendering");
const { chatQaEntries, nextChatQaRevision, qaFormSessions, resetChatQaCache } =
  await import("../../packages/cache/main/qa");

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
    // grammY 的 CommandContext 恒带 msg；夹具始终提供最小消息，再叠加覆写，
    // 避免制造生产中不存在的 undefined 形态。
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

const CHANNEL_ID: number = -1009999;

/** 发起者按「问题:」「回答:」格式投进群的一条普通消息。 */
function delivered(text: string, senderChatId?: number): never {
  return {
    message_id: 77,
    date: 1,
    chat: { id: CHAT_ID, type: "supergroup", title: "T" },
    text,
    from: { id: OWNER, is_bot: false, first_name: "A" },
    ...(senderChatId === undefined
      ? {}
      : { sender_chat: { id: senderChatId, type: "channel", title: "皮套" } }),
  } as never;
}

function lastText(): string {
  return sendCommandMessage.mock.calls.at(-1)?.[0].text ?? "";
}

beforeEach((): void => {
  sendCommandMessage.mockClear();
  sendMessage.mockClear();
  deleteMessageWithOutcome.mockClear();
  editMessageText.mockClear();
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

  test("持权限的频道身份也能开表单——命令侧与投递侧是同一个 sender_chat", async () => {
    permitted.add(CHANNEL_ID);

    await handleSetQaCommand(channelContext(""));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(qaFormSessions.get(CHAT_ID)?.openedById).toBe(CHANNEL_ID);
  });

  test("没有权限的频道身份同样拿不到表单", async () => {
    await handleSetQaCommand(channelContext(""));

    expect(lastText()).toContain("isCanControllQaPermission");
    expect(qaFormSessions.size).toBe(0);
  });

  test("没有 isCanControllQaPermission 的身份拿不到表单", async () => {
    await handleSetQaCommand(context(7, ""));

    expect(lastText()).toContain("isCanControllQaPermission");
    expect(qaFormSessions.size).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("获授权者拿到一张表单，会话按群建立并记下发起者", async () => {
    await handleSetQaCommand(context(OWNER, ""));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(qaFormSessions.get(CHAT_ID)?.openedById).toBe(OWNER);
  });

  test("话题群里 General 与其它话题一样发表单", async () => {
    const forum: ChatShape = { id: CHAT_ID, type: "supergroup", title: "T", is_forum: true };

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

  test("撞上每群上限时不开表单，先让人去删", async () => {
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

  test("带参数只查那一条，形状仍是数组——看板的结构必须稳定", async () => {
    chatQaEntries.set(CHAT_ID, new Map([["怎么入群？", "点置顶"]]));

    await handleQueryQaCommand(context(7, "怎么入群？"));

    const sent: SentMessage = sendCommandMessage.mock.calls.at(-1)![0];
    const entity = sent.entities![0]!;
    expect(JSON.parse(sent.text.slice(entity.offset, entity.offset + entity.length)))
      .toEqual([{ q: "怎么入群？", a: "点置顶" }]);
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
  test("本群没有未完成表单时同步返回 false，不为每条群消息分配 Promise", () => {
    // 绝大多数群任何时刻都没有开着的表单，判定只有一次以群 id 为键的 Map.get。
    // 本 handler 挂在每条群消息与频道帖之前（见 app/registerHandlers.ts），
    // 返回 Promise 就等于每条消息都白付一次分配与一个微任务回合。
    expect(qaFormSessions.has(CHAT_ID)).toBeFalse();
    expect(handleQaMessageIngress(delivered("问题:\n怎么入群？"))).toBe(false);
  });

  test("只填一项时留着表单，回执说明已记下哪一项", async () => {
    await handleSetQaCommand(context(OWNER, ""));
    sendCommandMessage.mockClear();

    const claimed: boolean = await handleQaMessageIngress(delivered("问题:\n怎么入群？"));

    expect(claimed).toBeTrue();
    expect(lastText()).toBe(QA_COMMAND_TEXTS.questionSaved);
    // 还差一项，会话必须留着。
    expect(qaFormSessions.get(CHAT_ID)).toBeDefined();
    expect(chatQaEntries.has(CHAT_ID)).toBeFalse();
  });

  test("收下一项后表单就地改写成当前状态，而不是永远显示两项皆空", async () => {
    await handleSetQaCommand(context(OWNER, ""));
    editMessageText.mockClear();

    await handleQaMessageIngress(delivered("问题:\n怎么入群？"));

    // 上面那条回执 30 秒后自删，之后只有表单还说得出这张单子填到了哪。
    const edited: EditedMessage = editMessageText.mock.calls.at(-1)![0];
    expect(edited.text).toBe(renderQaFormPrompt("怎么入群？", undefined));
    // 改写而不是重发：表单 id 是状态机持有的删除责任，换一条就再也删不掉旧的。
    expect(edited.chatId).toBe(CHAT_ID);
    expect(edited.messageId).toBe(55);
  });

  test("一项超长、另一项合规时，表单跟上合规的那一项", async () => {
    await handleSetQaCommand(context(OWNER, ""));
    editMessageText.mockClear();
    sendCommandMessage.mockClear();

    await handleQaMessageIngress(delivered(
      `问题:\n${"长".repeat(CHAT_QA_QUESTION_MAX_CHARS + 1)}\n回答:\n点置顶`
    ));

    // 回执只点名被挡下的那一项，合规的那项却已经进了会话——表单必须说得出来，
    // 否则用户只会以为整条消息都没被收下。
    expect(lastText()).toBe(QA_COMMAND_TEXTS.questionTooLong);
    expect(qaFormSessions.get(CHAT_ID)?.a).toBe("点置顶");
    expect(editMessageText.mock.calls.at(-1)![0].text)
      .toBe(renderQaFormPrompt(undefined, "点置顶"));
  });

  test("整条都被挡下时不改表单——会话一个字都没变", async () => {
    await handleSetQaCommand(context(OWNER, ""));
    editMessageText.mockClear();

    await handleQaMessageIngress(
      delivered(`问题:\n${"长".repeat(CHAT_QA_QUESTION_MAX_CHARS + 1)}`)
    );

    // 改写成同一份正文只会换来一次 Telegram 的「内容没有变化」，白跑一趟。
    expect(editMessageText).not.toHaveBeenCalled();
    expect(lastText()).toBe(QA_COMMAND_TEXTS.questionTooLong);
  });

  test("表单 id 还没登记上时不发编辑请求", async () => {
    // 发送成功但停机 abort 吃掉了返回值：onSent 没跑过，这条表单没有 id 可改。
    sendMessage.mockImplementationOnce(
      async (_message: { onSent?: (id: number) => void }): Promise<number | undefined> => undefined
    );
    await handleSetQaCommand(context(OWNER, ""));
    editMessageText.mockClear();

    await handleQaMessageIngress(delivered("问题:\n怎么入群？"));

    expect(editMessageText).not.toHaveBeenCalled();
    expect(qaFormSessions.get(CHAT_ID)?.q).toBe("怎么入群？");
  });

  test("两项填齐时不改表单——它紧接着就被删掉了", async () => {
    await handleSetQaCommand(context(OWNER, ""));
    await handleQaMessageIngress(delivered("问题:\n怎么入群？"));
    editMessageText.mockClear();

    await handleQaMessageIngress(delivered("回答:\n点置顶"));

    expect(editMessageText).not.toHaveBeenCalled();
    expect(deleteMessageWithOutcome).toHaveBeenCalled();
  });

  test("两项齐了就落库、收走表单，并按新增/覆盖如实回执", async () => {
    await handleSetQaCommand(context(OWNER, ""));
    await handleQaMessageIngress(delivered("问题:\n怎么入群？"));
    sendCommandMessage.mockClear();

    await handleQaMessageIngress(delivered("回答:\n点置顶"));

    expect(lastText()).toBe(QA_COMMAND_TEXTS.created);
    // 话题群里 bot 主动发的消息没有回复目标就会落进 General，而表单在话题里。
    expect(sendCommandMessage.mock.calls.at(-1)?.[0].replyToMessageId).toBe(55);
    expect(chatQaEntries.get(CHAT_ID)?.get("怎么入群？")).toBe("点置顶");
    // 结算之后表单会话与表单消息都不该再留着。
    expect(qaFormSessions.get(CHAT_ID)).toBeUndefined();
    expect(deleteMessageWithOutcome).toHaveBeenCalled();
  });

  test("两项写在同一条消息里也能一次结算", async () => {
    await handleSetQaCommand(context(OWNER, ""));
    sendCommandMessage.mockClear();

    await handleQaMessageIngress(delivered("问题:\n怎么入群？\n回答:\n点置顶"));

    expect(lastText()).toBe(QA_COMMAND_TEXTS.created);
    expect(chatQaEntries.get(CHAT_ID)?.get("怎么入群？")).toBe("点置顶");
  });

  test("覆盖同一问题时回执说覆盖，不谎称新增", async () => {
    chatQaEntries.set(CHAT_ID, new Map([["怎么入群？", "旧答案"]]));
    await handleSetQaCommand(context(OWNER, ""));
    await handleQaMessageIngress(delivered("问题:\n怎么入群？"));
    sendCommandMessage.mockClear();

    await handleQaMessageIngress(delivered("回答:\n新答案"));

    expect(lastText()).toBe(QA_COMMAND_TEXTS.replaced);
    expect(chatQaEntries.get(CHAT_ID)?.get("怎么入群？")).toBe("新答案");
  });

  test("频道身份开的表单由同一张皮填齐", async () => {
    permitted.add(CHANNEL_ID);
    await handleSetQaCommand(channelContext(""));

    await handleQaMessageIngress(delivered("问题:\n怎么入群？", CHANNEL_ID));
    await handleQaMessageIngress(delivered("回答:\n点置顶", CHANNEL_ID));

    expect(chatQaEntries.get(CHAT_ID)?.get("怎么入群？")).toBe("点置顶");
  });

  test("超长的那一项不写进会话，表单留着等重发", async () => {
    await handleSetQaCommand(context(OWNER, ""));
    sendCommandMessage.mockClear();

    const claimed: boolean = await handleQaMessageIngress(
      delivered(`问题:\n${"长".repeat(CHAT_QA_QUESTION_MAX_CHARS + 1)}`)
    );

    expect(claimed).toBeTrue();
    expect(lastText()).toBe(QA_COMMAND_TEXTS.questionTooLong);
    expect(qaFormSessions.get(CHAT_ID)?.q).toBeUndefined();
  });

  test("没有表单的消息不认领，交回下游流水线", async () => {
    expect(await handleQaMessageIngress(delivered("问题:\nx"))).toBeFalse();
  });

  test("不是发起者发的同格式消息不认领", async () => {
    await handleSetQaCommand(context(OWNER, ""));

    const other = { ...delivered("问题:\n怎么入群？") as object } as never;
    (other as { from: { id: number } }).from = { id: 7 };

    expect(await handleQaMessageIngress(other)).toBeFalse();
    expect(qaFormSessions.get(CHAT_ID)?.q).toBeUndefined();
  });
});

describe("落盘失败与容量拒绝的回执分流", () => {
  test("表单会话达到全局上限时当场说满，不顶掉别人正在填的那张", async () => {
    for (let index: number = 0; index < QA_FORM_SESSION_MAX; index++) {
      const otherChatId: number = -2000 - index;
      chatStates.set(otherChatId, { isInitEnabled: true });
      await handleSetQaCommand(context(OWNER, "", {
        chat: { id: otherChatId, type: "supergroup", title: "T" },
      }));
    }
    sendCommandMessage.mockClear();
    sendMessage.mockClear();

    await handleSetQaCommand(context(OWNER, ""));

    expect(lastText()).toBe(QA_COMMAND_TEXTS.formBusy);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(qaFormSessions.size).toBe(QA_FORM_SESSION_MAX);
  });

  test("已经进了热表却排不进硬盘时说「没写进硬盘」，不谎称满了", async () => {
    await handleSetQaCommand(context(OWNER, ""));
    await handleQaMessageIngress(delivered("问题:\n怎么入群？"));
    // revision 空间耗尽会让排队那一步抛错，此时条目已经写进热表。
    nextChatQaRevision.current = Number.MAX_SAFE_INTEGER;
    sendCommandMessage.mockClear();

    await handleQaMessageIngress(delivered("回答:\n点置顶"));

    expect(lastText()).toBe(QA_COMMAND_TEXTS.persistFailed);
    expect(chatQaEntries.get(CHAT_ID)?.get("怎么入群？")).toBe("点置顶");
    expect(qaFormSessions.get(CHAT_ID)).toBeUndefined();
  });

  test("填表期间被别的路径填满时说满了，而不是说盘写不进去", async () => {
    await handleSetQaCommand(context(OWNER, ""));
    await handleQaMessageIngress(delivered("问题:\n怎么入群？"));
    const entries = new Map<string, string>();
    for (let index: number = 0; index < CHAT_QA_MAX_PER_CHAT; index++) {
      entries.set(`问题${index}`, "答案");
    }
    chatQaEntries.set(CHAT_ID, entries);
    sendCommandMessage.mockClear();

    await handleQaMessageIngress(delivered("回答:\n点置顶"));

    // 容量拒绝时那条根本没进热表；说成「盘写不进去」会让人去查磁盘。
    expect(lastText()).toBe(QA_COMMAND_TEXTS.full);
    expect(chatQaEntries.get(CHAT_ID)?.has("怎么入群？")).toBeFalse();
  });

  test("/remove_qa 排不进硬盘时如实说没写进去", async () => {
    chatQaEntries.set(CHAT_ID, new Map([["怎么入群？", "点置顶"]]));
    nextChatQaRevision.current = Number.MAX_SAFE_INTEGER;

    await handleRemoveQaCommand(context(OWNER, "怎么入群？"));

    expect(lastText()).toBe(QA_COMMAND_TEXTS.persistFailed);
  });
});

describe("填到一半时重来", () => {
  test("重发同一字段直接覆盖，表单仍等另一项", async () => {
    await handleSetQaCommand(context(OWNER, ""));
    await handleQaMessageIngress(delivered("问题:\n打错的问题"));
    sendCommandMessage.mockClear();

    await handleQaMessageIngress(delivered("问题:\n怎么入群？"));

    expect(lastText()).toBe(QA_COMMAND_TEXTS.questionSaved);
    expect(qaFormSessions.get(CHAT_ID)?.q).toBe("怎么入群？");
    expect(qaFormSessions.get(CHAT_ID)?.a).toBeUndefined();
    expect(chatQaEntries.has(CHAT_ID)).toBeFalse();
  });

  test("同一个人重开 /set_qa：旧表单消息被删掉，已填的两项一并作废", async () => {
    await handleSetQaCommand(context(OWNER, ""));
    await handleQaMessageIngress(delivered("问题:\n怎么入群？"));
    const first: number | undefined = qaFormSessions.get(CHAT_ID)?.formMessageId;
    deleteMessageWithOutcome.mockClear();

    await handleSetQaCommand(context(OWNER, ""));

    // 旧那条表单消息不挂固定延迟清理，重开时不删就永远留在群里。
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(CHAT_ID, first);
    const session = qaFormSessions.get(CHAT_ID);
    expect(session).toBeDefined();
    expect(session?.q).toBeUndefined();
    expect(session?.a).toBeUndefined();
  });

  test("别人正在填时拒绝抢占，原表单原样留着", async () => {
    permitted.add(7);
    await handleSetQaCommand(context(OWNER, ""));
    await handleQaMessageIngress(delivered("问题:\n怎么入群？"));
    const original = qaFormSessions.get(CHAT_ID);
    sendCommandMessage.mockClear();
    sendMessage.mockClear();
    deleteMessageWithOutcome.mockClear();

    await handleSetQaCommand(context(7, ""));

    expect(lastText()).toBe(QA_COMMAND_TEXTS.formTaken);
    expect(sendMessage).not.toHaveBeenCalled();
    // 不悄悄顶掉别人填了一半的那张：会话、已填内容和表单消息全都不动。
    expect(deleteMessageWithOutcome).not.toHaveBeenCalled();
    expect(qaFormSessions.get(CHAT_ID)).toBe(original!);
    expect(qaFormSessions.get(CHAT_ID)?.q).toBe("怎么入群？");
  });

  test("表单结算之后再发格式消息不再被认领，交回下游流水线", async () => {
    await handleSetQaCommand(context(OWNER, ""));
    await handleQaMessageIngress(delivered("问题:\n怎么入群？"));
    await handleQaMessageIngress(delivered("回答:\n点置顶"));

    expect(await handleQaMessageIngress(delivered("回答:\n改主意了"))).toBeFalse();
    expect(chatQaEntries.get(CHAT_ID)?.get("怎么入群？")).toBe("点置顶");
  });
});
