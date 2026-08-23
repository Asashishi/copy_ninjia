import type { Message } from "@grammyjs/types";
import { beforeEach, describe, expect, test } from "bun:test";
import { chatQaEntries, resetChatQaCache } from "../../packages/cache/main/qa";
import { resolveQaDirectAnswer } from "../../packages/auto/message/qaDirectAnswer";

const CHAT_ID: number = -1001;
const BOT_USERNAME: string = "copy_ninjia_bot";

function message(text: string, entities?: Message["entities"]): Message {
  return {
    message_id: 7,
    date: 1,
    chat: { id: CHAT_ID, type: "supergroup", title: "T" },
    text,
    ...(entities === undefined ? {} : { entities }),
  } as Message;
}

beforeEach((): void => {
  resetChatQaCache();
});

describe("群问答直答", () => {
  test("本群没登记问答时不查表也不命中", () => {
    expect(resolveQaDirectAnswer(CHAT_ID, message("怎么入群？"), BOT_USERNAME))
      .toBeUndefined();
  });

  test("文本一字不差才命中", () => {
    chatQaEntries.set(CHAT_ID, new Map([["怎么入群？", "点置顶那条链接"]]));

    expect(resolveQaDirectAnswer(CHAT_ID, message("怎么入群？"), BOT_USERNAME))
      .toBe("点置顶那条链接");
    // 语义相近但文本不同不归直答：那条路交给模型的 group_qa_answer。
    expect(resolveQaDirectAnswer(CHAT_ID, message("请问怎么入群"), BOT_USERNAME))
      .toBeUndefined();
    expect(resolveQaDirectAnswer(CHAT_ID, message("怎么入群"), BOT_USERNAME))
      .toBeUndefined();
  });

  test("前导 @机器人 被剥掉后仍算完全一致", () => {
    chatQaEntries.set(CHAT_ID, new Map([["怎么入群？", "点置顶那条链接"]]));
    const mention: Message = message(
      `@${BOT_USERNAME} 怎么入群？`,
      [{ type: "mention", offset: 0, length: BOT_USERNAME.length + 1 }]
    );

    expect(resolveQaDirectAnswer(CHAT_ID, mention, BOT_USERNAME)).toBe("点置顶那条链接");
  });

  test("句中的 @提及不剥：那会得到用户从没打出来过的串", () => {
    chatQaEntries.set(CHAT_ID, new Map([["怎么入群？", "点置顶那条链接"]]));
    const mention: Message = message(
      `问 @${BOT_USERNAME} 怎么入群？`,
      [{ type: "mention", offset: 2, length: BOT_USERNAME.length + 1 }]
    );

    expect(resolveQaDirectAnswer(CHAT_ID, mention, BOT_USERNAME)).toBeUndefined();
  });

  test("别的机器人的 @提及不剥", () => {
    chatQaEntries.set(CHAT_ID, new Map([["怎么入群？", "点置顶那条链接"]]));
    const mention: Message = message(
      "@other_bot 怎么入群？",
      [{ type: "mention", offset: 0, length: "@other_bot".length }]
    );

    expect(resolveQaDirectAnswer(CHAT_ID, mention, BOT_USERNAME)).toBeUndefined();
  });

  test("非文本消息不命中", () => {
    chatQaEntries.set(CHAT_ID, new Map([["怎么入群？", "点置顶那条链接"]]));
    const sticker: Message = {
      message_id: 7,
      date: 1,
      chat: { id: CHAT_ID, type: "supergroup", title: "T" },
    } as Message;

    expect(resolveQaDirectAnswer(CHAT_ID, sticker, BOT_USERNAME)).toBeUndefined();
  });

  test("只在本群的表里查，不串群", () => {
    chatQaEntries.set(CHAT_ID, new Map([["怎么入群？", "点置顶那条链接"]]));

    expect(resolveQaDirectAnswer(-1002, message("怎么入群？"), BOT_USERNAME))
      .toBeUndefined();
  });
});
