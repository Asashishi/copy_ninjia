import type { Message } from "grammy/types";
import { beforeEach, describe, expect, test } from "bun:test";
import { chatQaEntries, resetChatQaCache } from "../../packages/cache/main/qa";
import { resolveMentionFacts } from "../../packages/auto/message/facts";
import { resolveQaDirectAnswer } from "../../packages/auto/message/qaDirectAnswer";

const CHAT_ID: number = -1001;
const BOT_ID: number = 42;
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

  test("@机器人 的用户名比对折大小写，与 AI 触发口径一致", () => {
    // BotFather 里注册的是混合大小写，用户手打却常是全小写或全大写；Telegram
    // 用户名本身大小写不敏感，三种写法都会生成同一条指向本机器人的 mention 实体。
    // 直答这里若区分大小写，同一条消息就会「AI 触发认、直答不认」，白付一次模型
    // 调用去回答一个已经写死的答案。
    const canonical: string = "Copy_Ninjia_Bot";
    chatQaEntries.set(CHAT_ID, new Map([["怎么入群？", "点置顶那条链接"]]));

    for (const typed of ["@Copy_Ninjia_Bot", "@copy_ninjia_bot", "@COPY_NINJIA_BOT"]) {
      const mention: Message = message(
        `${typed} 怎么入群？`,
        [{ type: "mention", offset: 0, length: typed.length }]
      );

      expect(resolveMentionFacts(mention, BOT_ID, canonical).isMentioned).toBeTrue();
      expect(resolveQaDirectAnswer(CHAT_ID, mention, canonical)).toBe("点置顶那条链接");
    }
  });

  test("同前缀但更长的用户名不剥：折大小写不等于放宽匹配", () => {
    chatQaEntries.set(CHAT_ID, new Map([["怎么入群？", "点置顶那条链接"]]));
    const other: string = `@${BOT_USERNAME}2`;
    const mention: Message = message(
      `${other} 怎么入群？`,
      [{ type: "mention", offset: 0, length: other.length }]
    );

    expect(resolveQaDirectAnswer(CHAT_ID, mention, BOT_USERNAME)).toBeUndefined();
  });

  test("折的只是用户名，问题文本仍然区分大小写", () => {
    chatQaEntries.set(CHAT_ID, new Map([["How To Join", "pinned link"]]));

    expect(resolveQaDirectAnswer(CHAT_ID, message("How To Join"), BOT_USERNAME))
      .toBe("pinned link");
    expect(resolveQaDirectAnswer(CHAT_ID, message("how to join"), BOT_USERNAME))
      .toBeUndefined();
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
