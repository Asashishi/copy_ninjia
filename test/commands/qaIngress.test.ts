import type { Message, MessageEntity } from "grammy/types";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  CHAT_QA_ANSWER_MAX_CHARS,
  CHAT_QA_QUESTION_MAX_CHARS,
} from "../../packages/consts/qa";

const deleteMessageWithOutcome = mock(async (): Promise<unknown> => ({ deleted: true }));
mock.module("../../packages/infra/telegram", () => ({
  deleteMessageWithOutcome,
  logApiError: (): void => {},
}));
let botOwnMessage: boolean = false;
/** 同步标记还没到、但有界 rendezvous 等到了它——Worker 发送的固有时序。 */
let lateBotOwnMessage: boolean = false;
mock.module("../../packages/infra/selfSentTracker", () => ({
  isBotOwnMessage: (): boolean => botOwnMessage,
  needsBotOwnMessageWait: (message: Message): boolean => message.chat.type === "channel",
  waitForBotOwnMessage: async (): Promise<boolean> => botOwnMessage || lateBotOwnMessage,
}));

const { claimQaFieldMessage } = await import("../../packages/commands/qa/ingress");
const { openQaFormSession } = await import("../../packages/commands/qa/session");
const { resetChatQaCache, qaFormSessions } = await import("../../packages/cache/main/qa");

const CHAT_ID: number = -1001;
const OWNER: number = 42;
const CHANNEL_ID: number = -1009999;
const FORM_MESSAGE_ID: number = 55;
const JSON_BODY: string = '[\n  {\n    "称号": "天朝撞库王"\n  }\n]';

interface DeliveredOptions {
  readonly fromId?: number;
  readonly senderChatId?: number;
  readonly messageId?: number;
  readonly entities?: readonly MessageEntity[];
}

function delivered(text: string, options: DeliveredOptions = {}): Message {
  return {
    message_id: options.messageId ?? 77,
    date: 1,
    chat: { id: CHAT_ID, type: "supergroup", title: "T" },
    text,
    from: { id: options.fromId ?? OWNER, is_bot: false, first_name: "A" },
    ...(options.senderChatId === undefined
      ? {}
      : { sender_chat: { id: options.senderChatId, type: "channel", title: "皮套" } }),
    ...(options.entities === undefined ? {} : { entities: [...options.entities] }),
  } as Message;
}

/**
 * 频道帖：Telegram 会把本天才自己在频道发的帖原样推回来，而它的可见身份就是
 * 频道本身——与「频道身份开的表单」的 openedById 恒相等，按身份的判据挡不住。
 */
function channelPost(text: string, messageId: number = 78): Message {
  return {
    message_id: messageId,
    date: 1,
    chat: { id: CHAT_ID, type: "channel", title: "T" },
    text,
  } as Message;
}

/** 开一张表单并把表单消息 id 登记上，与生产里 onSent 那一步同构。 */
function openForm(openedById: number): void {
  const session = openQaFormSession({
    chatId: CHAT_ID,
    openedById,
    onDiscard: (): void => {},
  });
  if (session !== null) session.formMessageId = FORM_MESSAGE_ID;
}

beforeEach((): void => {
  deleteMessageWithOutcome.mockClear();
  botOwnMessage = false;
  lateBotOwnMessage = false;
  resetChatQaCache();
});

describe("表单投递的认领判据", () => {
  test("没有表单的群一律不认领", async () => {
    expect(await claimQaFieldMessage(delivered("问题:\n怎么入群？"))).toBeNull();
    expect(deleteMessageWithOutcome).not.toHaveBeenCalled();
  });

  test("发起者按格式投递即认领，并删掉那条投递消息", async () => {
    openForm(OWNER);

    const claimed = await claimQaFieldMessage(delivered("问题:\n怎么入群？"));

    expect(claimed?.accepted).toEqual({ q: "怎么入群？", a: undefined });
    expect(qaFormSessions.get(CHAT_ID)?.q).toBe("怎么入群？");
    expect(deleteMessageWithOutcome).toHaveBeenCalledWith(CHAT_ID, 77);
  });

  test("别人发的同格式消息不认领，也不删——那是他自己的发言", async () => {
    openForm(OWNER);

    expect(await claimQaFieldMessage(delivered("问题:\n怎么入群？", { fromId: 7 }))).toBeNull();
    expect(deleteMessageWithOutcome).not.toHaveBeenCalled();
    expect(qaFormSessions.get(CHAT_ID)?.q).toBeUndefined();
  });

  test("频道身份开的表单只认同一张皮，不认皮下的真实账号", async () => {
    openForm(CHANNEL_ID);

    expect(await claimQaFieldMessage(
      delivered("问题:\n怎么入群？", { senderChatId: CHANNEL_ID })
    )).not.toBeNull();
    expect(qaFormSessions.get(CHAT_ID)?.q).toBe("怎么入群？");

    // Telegram 附带的匿名服务账号不是那张皮。
    expect(await claimQaFieldMessage(delivered("回答:\n点置顶"))).toBeNull();
  });

  test("本天才自己发的帖回投时不认领——否则表单会拿示例把自己填满", async () => {
    openForm(OWNER);
    botOwnMessage = true;

    // 表单提示正文里就写着「问题:」「回答:」两行示例。
    expect(await claimQaFieldMessage(
      delivered("问题:\n（要人原样问出来的那句）\n回答:\n（本天才替你答的那段）")
    )).toBeNull();
    expect(qaFormSessions.get(CHAT_ID)?.q).toBeUndefined();
  });

  test("Worker 发的帖标记晚到时由有界 rendezvous 挡下——同步判定此刻看不见它", async () => {
    // 频道身份开的表单：可见身份就是频道自己，按身份的判据与它恒相等。
    openForm(CHAT_ID);
    // aiChat Worker 经双工代理发出的回复走主线程的 bot.api.raw，self-sent 要等
    // Worker 的 sent 事件才补上，与 channel_post 回投没有顺序保证。
    lateBotOwnMessage = true;

    expect(await claimQaFieldMessage(channelPost("回答:\n本天才随口答的一段"))).toBeNull();
    // 认领的代价是删掉那条消息并把正文写进问答；自回环一条都不能走到这一步。
    expect(deleteMessageWithOutcome).not.toHaveBeenCalled();
    expect(qaFormSessions.get(CHAT_ID)?.a).toBeUndefined();
  });

  test("等不到标记的频道帖照常认领——那是真人以频道身份投的", async () => {
    openForm(CHAT_ID);

    const claimed = await claimQaFieldMessage(channelPost("回答:\n点置顶"));

    expect(claimed?.accepted.a).toBe("点置顶");
    expect(qaFormSessions.get(CHAT_ID)?.a).toBe("点置顶");
    expect(deleteMessageWithOutcome).toHaveBeenCalled();
  });

  test("表单消息自己不参与认领", async () => {
    openForm(OWNER);

    expect(await claimQaFieldMessage(
      delivered("问题:\nx", { messageId: FORM_MESSAGE_ID })
    )).toBeNull();
  });

  test("认领不到字段的消息原样放回流水线", async () => {
    openForm(OWNER);

    expect(await claimQaFieldMessage(delivered("今天天气不错"))).toBeNull();
    expect(deleteMessageWithOutcome).not.toHaveBeenCalled();
  });
});

describe("长度闸", () => {
  test("超长问题不写进会话，只报超长", async () => {
    openForm(OWNER);

    const claimed = await claimQaFieldMessage(
      delivered(`问题:\n${"长".repeat(CHAT_QA_QUESTION_MAX_CHARS + 1)}`)
    );

    expect(claimed?.questionTooLong).toBeTrue();
    expect(claimed?.accepted.q).toBeUndefined();
    expect(qaFormSessions.get(CHAT_ID)?.q).toBeUndefined();
    // 已经认领了就得删：那条超长消息没有别的用途。
    expect(deleteMessageWithOutcome).toHaveBeenCalled();
  });

  test("超长答案同理，且不影响已经填好的问题", async () => {
    openForm(OWNER);
    await claimQaFieldMessage(delivered("问题:\n怎么入群？"));

    const claimed = await claimQaFieldMessage(
      delivered(`回答:\n${"长".repeat(CHAT_QA_ANSWER_MAX_CHARS + 1)}`)
    );

    expect(claimed?.answerTooLong).toBeTrue();
    expect(qaFormSessions.get(CHAT_ID)?.a).toBeUndefined();
    expect(qaFormSessions.get(CHAT_ID)?.q).toBe("怎么入群？");
  });

  test("正好卡在上限上的答案收下", async () => {
    openForm(OWNER);

    const claimed = await claimQaFieldMessage(
      delivered(`回答:\n${"长".repeat(CHAT_QA_ANSWER_MAX_CHARS)}`)
    );

    expect(claimed?.answerTooLong).toBeFalse();
    expect(qaFormSessions.get(CHAT_ID)?.a?.length).toBe(CHAT_QA_ANSWER_MAX_CHARS);
  });
});

describe("代码块投递", () => {
  test("```json 块以字面围栏存进会话", async () => {
    openForm(OWNER);
    const text: string = `回答:\n${JSON_BODY}`;

    await claimQaFieldMessage(delivered(text, {
      entities: [{ type: "pre", offset: 4, length: JSON_BODY.length, language: "json" }],
    }));

    expect(qaFormSessions.get(CHAT_ID)?.a).toBe(`\`\`\`json\n${JSON_BODY}\n\`\`\``);
  });

  test("围栏本身也算进答案长度", async () => {
    openForm(OWNER);
    // 块内正文刚好卡满上限时，补上的围栏会把它顶出去。
    const body: string = "长".repeat(CHAT_QA_ANSWER_MAX_CHARS);
    const text: string = `回答:\n${body}`;

    const claimed = await claimQaFieldMessage(delivered(text, {
      entities: [{ type: "pre", offset: 4, length: body.length, language: "json" }],
    }));

    expect(claimed?.answerTooLong).toBeTrue();
  });
});
