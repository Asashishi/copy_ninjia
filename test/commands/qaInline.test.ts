import type { Message } from "@grammyjs/types";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  CHAT_QA_QUESTION_MAX_CHARS,
  QA_INLINE_ANSWER_PREFIX,
  QA_INLINE_QUESTION_PREFIX,
} from "../../packages/consts/qa";

const deleteMessageWithOutcome = mock(async (): Promise<unknown> => ({ deleted: true }));
mock.module("../../packages/infra/telegram", () => ({
  deleteMessageWithOutcome,
  logApiError: (): void => {},
}));
mock.module("../../packages/infra/updateContext", () => ({
  currentUpdateAbortSignal: (): undefined => undefined,
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getQaThumbnailUrl: (): string => "https://example.invalid/qa.png",
}));
const permitted: Set<number> = new Set<number>([42]);
mock.module("../../packages/infra/identityPolicy/whitelist", () => ({
  hasWhitelistPermission: (id: number): boolean => permitted.has(id),
}));

const { claimQaFormMessage, handleQaInlineQuery, isQaInlineQuery } =
  await import("../../packages/commands/qa/inline");
const { renderQaInlineResult } = await import("../../packages/commands/qa/rendering");
const { openQaFormSession } = await import("../../packages/commands/qa/session");
const { resetChatQaCache } = await import("../../packages/cache/main/qa");

const CHAT_ID: number = -1001;
const OWNER: number = 42;
const BOT_ID: number = 999;

let answered: unknown[][] = [];

function inlineContext(query: string, fromId: number): never {
  return {
    inlineQuery: { id: "1", from: { id: fromId }, query, offset: "" },
    answerInlineQuery: async (...args: unknown[]): Promise<void> => {
      answered.push(args);
    },
  } as never;
}

function landedMessage(text: string, fromId: number, viaBotId: number | undefined): Message {
  return {
    message_id: 77,
    date: 1,
    chat: { id: CHAT_ID, type: "supergroup", title: "T" },
    text,
    from: { id: fromId, is_bot: false, first_name: "A" },
    ...(viaBotId === undefined ? {} : { via_bot: { id: viaBotId, is_bot: true, first_name: "B" } }),
  } as Message;
}

beforeEach((): void => {
  answered = [];
  deleteMessageWithOutcome.mockClear();
  resetChatQaCache();
});

describe("/set_qa 的 inline 查询", () => {
  test("带本领域前缀就认领，绝不退回运势", async () => {
    expect(isQaInlineQuery(`${QA_INLINE_QUESTION_PREFIX}${CHAT_ID} x`)).toBeTrue();
    expect(isQaInlineQuery(`${QA_INLINE_ANSWER_PREFIX}${CHAT_ID} x`)).toBeTrue();
    expect(isQaInlineQuery("gag:123 x")).toBeFalse();

    // 前缀拼错、群 id 解析不出来时也认领，只是回空结果——不能变成抽签。
    expect(await handleQaInlineQuery(inlineContext(`${QA_INLINE_QUESTION_PREFIX}abc x`, OWNER)))
      .toBeTrue();
    expect(answered[0]![0]).toEqual([]);
  });

  test("非本领域前缀不认领", async () => {
    expect(await handleQaInlineQuery(inlineContext("随便问问", OWNER))).toBeFalse();
    expect(answered).toHaveLength(0);
  });

  test("没有属于查询者的表单时只回空结果", async () => {
    await handleQaInlineQuery(inlineContext(`${QA_INLINE_QUESTION_PREFIX}${CHAT_ID} 怎么入群？`, OWNER));

    expect(answered[0]![0]).toEqual([]);
  });

  test("有表单且长度合规时给一条带缩略图的结果", async () => {
    openQaFormSession({ chatId: CHAT_ID, openedById: OWNER, onExpire: (): void => {} });

    await handleQaInlineQuery(inlineContext(`${QA_INLINE_QUESTION_PREFIX}${CHAT_ID} 怎么入群？`, OWNER));

    const results = answered[0]![0] as { thumbnail_url?: string }[];
    expect(results).toHaveLength(1);
    // 没有缩略图的 inline 结果在客户端里是一行灰条，很难认出是哪个功能。
    expect(results[0]!.thumbnail_url).toBe("https://example.invalid/qa.png");
  });

  test("超长内容不给结果", async () => {
    openQaFormSession({ chatId: CHAT_ID, openedById: OWNER, onExpire: (): void => {} });
    const tooLong: string = "a".repeat(CHAT_QA_QUESTION_MAX_CHARS + 1);

    await handleQaInlineQuery(inlineContext(`${QA_INLINE_QUESTION_PREFIX}${CHAT_ID} ${tooLong}`, OWNER));

    expect(answered[0]![0]).toEqual([]);
  });

  test("表单按群索引：本群有表单时，任何查询者都能拿到结果", async () => {
    // 这一步不写任何东西，纯 UX 闸——inline 查询看不到当前群，鉴权留给落群那步。
    // 匿名管理员开的表单能被真实用户账号填上，正是靠这条。
    openQaFormSession({ chatId: CHAT_ID, openedById: CHAT_ID, onExpire: (): void => {} });

    await handleQaInlineQuery(inlineContext(`${QA_INLINE_QUESTION_PREFIX}${CHAT_ID} 怎么入群？`, 7));

    expect(answered[0]![0]).toHaveLength(1);
  });
});

describe("表单结果落群的认领判据", () => {
  test("认领后写回会话并删掉那条中转消息", async () => {
    const session = openQaFormSession({
      chatId: CHAT_ID,
      openedById: OWNER,
      onExpire: (): void => {},
    })!;

    const claimed = await claimQaFormMessage(
      landedMessage(renderQaInlineResult("q", "怎么入群？"), OWNER, BOT_ID),
      BOT_ID
    );

    expect(claimed?.field).toBe("q");
    expect(session.q).toBe("怎么入群？");
    expect(deleteMessageWithOutcome).toHaveBeenCalledTimes(1);
  });

  test("不是 via_bot 的消息一律不认领：手打同样的前缀走不到这条路径", async () => {
    openQaFormSession({ chatId: CHAT_ID, openedById: OWNER, onExpire: (): void => {} });

    expect(await claimQaFormMessage(
      landedMessage(renderQaInlineResult("q", "怎么入群？"), OWNER, undefined),
      BOT_ID
    )).toBeNull();
    // 别的机器人的 inline 结果同样不认领。
    expect(await claimQaFormMessage(
      landedMessage(renderQaInlineResult("q", "x"), OWNER, 12345),
      BOT_ID
    )).toBeNull();
    expect(deleteMessageWithOutcome).not.toHaveBeenCalled();
  });

  test("没有权限的身份投进来时认领但不写入，表单留着等有资格的人", async () => {
    const session = openQaFormSession({
      chatId: CHAT_ID,
      openedById: CHAT_ID,
      onExpire: (): void => {},
    })!;

    const claimed = await claimQaFormMessage(
      landedMessage(renderQaInlineResult("q", "x"), 7, BOT_ID),
      BOT_ID
    );

    expect(claimed?.permitted).toBeFalse();
    expect(session.q).toBeUndefined();
    // 那条中转消息没有别的用途，仍然要删掉。
    expect(deleteMessageWithOutcome).toHaveBeenCalledTimes(1);
  });

  test("带频道马甲的落群结果不写入：与命令侧同一道口径", async () => {
    const session = openQaFormSession({
      chatId: CHAT_ID,
      openedById: OWNER,
      onExpire: (): void => {},
    })!;
    const masked = landedMessage(renderQaInlineResult("q", "x"), OWNER, BOT_ID) as Message & {
      sender_chat?: unknown;
    };
    masked.sender_chat = { id: -1009999, type: "channel", title: "皮套" };
    permitted.add(-1009999);

    const claimed = await claimQaFormMessage(masked, BOT_ID);

    // 命令侧挡住的身份不能从这条路绕进来，哪怕那张皮自己持有权限。
    expect(claimed?.permitted).toBeFalse();
    expect(session.q).toBeUndefined();
  });

  test("匿名管理员开的表单，由真实用户账号填上（本次线上 bug 的回归）", async () => {
    // /set_qa 以 sender_chat 发出时 openedById 是群 id，而 inline 结果必然来自
    // 真实用户账号。按人索引的旧实现在这里永远找不到表单。
    const session = openQaFormSession({
      chatId: CHAT_ID,
      openedById: CHAT_ID,
      onExpire: (): void => {},
    })!;

    const claimed = await claimQaFormMessage(
      landedMessage(renderQaInlineResult("q", "山本"), OWNER, BOT_ID),
      BOT_ID
    );

    expect(claimed?.permitted).toBeTrue();
    expect(session.q).toBe("山本");
  });

  test("没有本领域标签的正文不认领", async () => {
    openQaFormSession({ chatId: CHAT_ID, openedById: OWNER, onExpire: (): void => {} });

    expect(await claimQaFormMessage(landedMessage("怎么入群？", OWNER, BOT_ID), BOT_ID))
      .toBeNull();
  });

  test("答案标签写进会话的 a 而不是 q", async () => {
    const session = openQaFormSession({
      chatId: CHAT_ID,
      openedById: OWNER,
      onExpire: (): void => {},
    })!;

    await claimQaFormMessage(
      landedMessage(renderQaInlineResult("a", "点置顶"), OWNER, BOT_ID),
      BOT_ID
    );

    expect(session.a).toBe("点置顶");
    expect(session.q).toBeUndefined();
  });
});
