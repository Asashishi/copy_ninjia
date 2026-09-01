import type { InlineKeyboardButton } from "grammy/types";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  CHAT_QA_ANSWER_MAX_CHARS,
  CHAT_QA_QUESTION_MAX_CHARS,
  QA_QUERY_ANSWER_PREVIEW_MAX_CHARS,
  QA_QUERY_PAGE_CALLBACK_PREFIX,
  QA_QUERY_PAGE_MAX_ENTRIES,
  QA_QUERY_PAGE_NEXT_TEXT,
  QA_QUERY_PAGE_NOOP_DATA,
  QA_QUERY_PAGE_PREV_TEXT,
  QA_TRUNCATION_MARK,
  QA_COMMAND_TEXTS,
} from "../../packages/consts/qa";
import { TELEGRAM_MESSAGE_MAX_CHARS } from "../../packages/consts/telegram";

interface EditCall {
  chatId: number;
  messageId: number;
  text: string;
  entities?: readonly { type: string; offset: number; length: number }[];
  keyboard?: { inline_keyboard: InlineKeyboardButton[][] };
}

const answerCallbackQuery = mock(async (): Promise<void> => {});
const editMessageText = mock(async (_call: EditCall): Promise<boolean> => true);
mock.module("../../packages/infra/telegram", () => ({
  answerCallbackQuery,
  editMessageText,
  logApiError: (): void => {},
}));

const {
  buildQaBoardKeyboard,
  buildQaBoardPages,
  handleQaBoardCallback,
} = await import("../../packages/commands/qa/board");
const { chatQaEntries, resetChatQaCache } = await import("../../packages/cache/main/qa");

const CHAT_ID: number = -1001;
const BOARD_MESSAGE_ID: number = 88;

function callbackContext(data: string): never {
  return {
    callbackQuery: {
      id: "cb-1",
      data,
      from: { id: 42, is_bot: false, first_name: "A" },
      chat_instance: "x",
      message: {
        message_id: BOARD_MESSAGE_ID,
        date: 1,
        chat: { id: CHAT_ID, type: "supergroup", title: "T" },
      },
    },
  } as never;
}

/** 取出一页 JSON 代码块里解析出来的条目。 */
function parsePage(text: string, entity: { offset: number; length: number }): unknown {
  return JSON.parse(text.slice(entity.offset, entity.offset + entity.length));
}

function buttonTexts(keyboard: { inline_keyboard: InlineKeyboardButton[][] } | undefined): string[] {
  return (keyboard?.inline_keyboard[0] ?? []).map(
    (button: InlineKeyboardButton): string => button.text
  );
}

beforeEach((): void => {
  answerCallbackQuery.mockClear();
  editMessageText.mockClear();
  resetChatQaCache();
});

describe("看板装页", () => {
  test("装得下就是一页，形状恒为数组", () => {
    const pages = buildQaBoardPages([{ q: "a", a: "1" }, { q: "b", a: "2" }]);

    expect(pages).toHaveLength(1);
    expect(parsePage(pages[0]!.text, pages[0]!.entities[0]!))
      .toEqual([{ q: "a", a: "1" }, { q: "b", a: "2" }]);
    expect(pages[0]!.entities[0]).toMatchObject({ type: "pre", language: "json" });
  });

  test("超过每页条数就分页，短问答也照样分", () => {
    // 这正是按条数装页要保住的行为：预算装页会让 5 条短问答全挤进一页，
    // buildQaBoardKeyboard 在只有一页时返回 undefined，翻页条整个不出现。
    const entries = Array.from({ length: 5 }, (_unused: unknown, index: number) => ({
      q: `问题${index}`,
      a: `答案${index}`,
    }));

    const pages = buildQaBoardPages(entries);

    expect(pages).toHaveLength(2);
    expect(parsePage(pages[0]!.text, pages[0]!.entities[0]!) as unknown[])
      .toHaveLength(QA_QUERY_PAGE_MAX_ENTRIES);
    expect(parsePage(pages[1]!.text, pages[1]!.entities[0]!) as unknown[]).toHaveLength(2);
    expect(buildQaBoardKeyboard(0, pages.length)).toBeDefined();
  });

  test("每页恰好装满时不留空页", () => {
    const entries = Array.from({ length: QA_QUERY_PAGE_MAX_ENTRIES * 2 }, (
      _unused: unknown,
      index: number
    ) => ({ q: `问题${index}`, a: `答案${index}` }));

    const pages = buildQaBoardPages(entries);

    expect(pages).toHaveLength(2);
    for (const page of pages) {
      expect(parsePage(page.text, page.entities[0]!) as unknown[])
        .toHaveLength(QA_QUERY_PAGE_MAX_ENTRIES);
    }
  });

  test("满页三条在两项都取上限时仍在 Telegram 单条上限之内", () => {
    // 问题受 CHAT_QA_QUESTION_MAX_CHARS 约束、答案被看板预览上限压过，
    // 因此按条数装页不需要再叠一道长度闸。
    const entries = Array.from({ length: QA_QUERY_PAGE_MAX_ENTRIES }, () => ({
      q: "问".repeat(CHAT_QA_QUESTION_MAX_CHARS),
      a: "答".repeat(CHAT_QA_ANSWER_MAX_CHARS),
    }));

    const pages = buildQaBoardPages(entries);

    expect(pages).toHaveLength(1);
    expect(pages[0]!.text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_CHARS);
  });

  test("分页不得吞条目：各页拼起来与入参等长", () => {
    for (const count of [1, 2, 3, 4, 5, 7]) {
      const entries = Array.from({ length: count }, (_unused: unknown, index: number) => ({
        q: `问题${index}`,
        a: "长".repeat(QA_QUERY_ANSWER_PREVIEW_MAX_CHARS),
      }));

      const pages = buildQaBoardPages(entries);

      expect(pages).toHaveLength(Math.ceil(count / QA_QUERY_PAGE_MAX_ENTRIES));
      const total: number = pages.reduce(
        (sum: number, page): number =>
          sum + (parsePage(page.text, page.entities[0]!) as unknown[]).length,
        0
      );
      expect(total).toBe(count);
    }
  });

  test("答案截断到上限并补省略号，问题一字不改", () => {
    const question: string = "问".repeat(200);
    const answer: string = "答".repeat(QA_QUERY_ANSWER_PREVIEW_MAX_CHARS + 100);

    const pages = buildQaBoardPages([{ q: question, a: answer }]);
    const parsed = parsePage(pages[0]!.text, pages[0]!.entities[0]!) as { q: string; a: string }[];

    // 问题是 /remove_qa 的入参，截断过的照抄回去什么也删不掉。
    expect(parsed[0]!.q).toBe(question);
    expect(parsed[0]!.a).toHaveLength(QA_QUERY_ANSWER_PREVIEW_MAX_CHARS);
    expect(parsed[0]!.a.endsWith(QA_TRUNCATION_MARK)).toBeTrue();
  });

  test("没到上限的答案原样保留，不补省略号", () => {
    const pages = buildQaBoardPages([{ q: "a", a: "点置顶" }]);
    const parsed = parsePage(pages[0]!.text, pages[0]!.entities[0]!) as { a: string }[];

    expect(parsed[0]!.a).toBe("点置顶");
  });

  test("代码块答案在看板上按字面围栏显示", () => {
    const pages = buildQaBoardPages([{ q: "a", a: "```json\n[]\n```" }]);
    const parsed = parsePage(pages[0]!.text, pages[0]!.entities[0]!) as { a: string }[];

    expect(parsed[0]!.a).toBe("```json\n[]\n```");
  });
});

describe("翻页条", () => {
  test("只有一页时不画按钮", () => {
    expect(buildQaBoardKeyboard(0, 1)).toBeUndefined();
  });

  test("首页没有上一页，末页没有下一页", () => {
    expect(buttonTexts(buildQaBoardKeyboard(0, 3))).toEqual([
      "1/3",
      QA_QUERY_PAGE_NEXT_TEXT,
    ]);
    expect(buttonTexts(buildQaBoardKeyboard(2, 3))).toEqual([
      QA_QUERY_PAGE_PREV_TEXT,
      "3/3",
    ]);
    expect(buttonTexts(buildQaBoardKeyboard(1, 3))).toEqual([
      QA_QUERY_PAGE_PREV_TEXT,
      "2/3",
      QA_QUERY_PAGE_NEXT_TEXT,
    ]);
  });
});

describe("翻页回调", () => {
  test("不是本领域前缀的一律不认领", async () => {
    expect(await handleQaBoardCallback(callbackContext("verify:42"))).toBeFalse();
    expect(answerCallbackQuery).not.toHaveBeenCalled();
  });

  test("认领后当场应答，并按目标页改写同一条消息", async () => {
    chatQaEntries.set(CHAT_ID, new Map(
      Array.from({ length: 5 }, (_unused: unknown, index: number): [string, string] =>
        [`问题${index}`, "长".repeat(QA_QUERY_ANSWER_PREVIEW_MAX_CHARS)])
    ));

    expect(await handleQaBoardCallback(callbackContext(`${QA_QUERY_PAGE_CALLBACK_PREFIX}1`)))
      .toBeTrue();

    expect(answerCallbackQuery).toHaveBeenCalled();
    const call: EditCall = editMessageText.mock.calls.at(-1)![0];
    expect(call.chatId).toBe(CHAT_ID);
    expect(call.messageId).toBe(BOARD_MESSAGE_ID);
    expect(buttonTexts(call.keyboard)).toContain(QA_QUERY_PAGE_PREV_TEXT);
  });

  test("页码指示按钮只应答，不发编辑请求", async () => {
    chatQaEntries.set(CHAT_ID, new Map([["a", "1"]]));

    expect(await handleQaBoardCallback(callbackContext(QA_QUERY_PAGE_NOOP_DATA))).toBeTrue();

    expect(answerCallbackQuery).toHaveBeenCalled();
    expect(editMessageText).not.toHaveBeenCalled();
  });

  test("页号越界时夹回现有范围，不报错", async () => {
    chatQaEntries.set(CHAT_ID, new Map([["a", "1"]]));

    await handleQaBoardCallback(callbackContext(`${QA_QUERY_PAGE_CALLBACK_PREFIX}9`));

    const call: EditCall = editMessageText.mock.calls.at(-1)![0];
    expect(parsePage(call.text, call.entities![0]!)).toEqual([{ q: "a", a: "1" }]);
    // 只剩一页，翻页条要跟着收走。
    expect(call.keyboard).toBeUndefined();
  });

  test("条目已被删光时就地收敛成空看板", async () => {
    await handleQaBoardCallback(callbackContext(`${QA_QUERY_PAGE_CALLBACK_PREFIX}0`));

    const call: EditCall = editMessageText.mock.calls.at(-1)![0];
    expect(call.text).toBe(QA_COMMAND_TEXTS.queryEmpty);
    expect(call.keyboard).toBeUndefined();
  });

  test("页号不是合法整数时只应答，不改写", async () => {
    chatQaEntries.set(CHAT_ID, new Map([["a", "1"]]));

    expect(await handleQaBoardCallback(callbackContext(`${QA_QUERY_PAGE_CALLBACK_PREFIX}abc`)))
      .toBeTrue();

    expect(answerCallbackQuery).toHaveBeenCalled();
    expect(editMessageText).not.toHaveBeenCalled();
  });
});
