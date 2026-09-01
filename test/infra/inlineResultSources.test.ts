/** 全部 inline 功能共用的「结果正文 → 查询源文本」登记表。 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { InlineQueryResult } from "grammy/types";
import { inlineResultSources } from "../../packages/cache/main/inlineResultSources";
import { INLINE_RESULT_SOURCE_MAX_AUTHORS } from "../../packages/consts/telegram";
import {
  inlineResultSourceOf,
  recordInlineResultSources,
} from "../../packages/infra/inlineResultSources";

function textResult(id: string, messageText: string): InlineQueryResult {
  return {
    type: "article",
    id,
    title: id,
    input_message_content: { message_text: messageText },
  };
}

beforeEach(() => {
  inlineResultSources.clear();
});

describe("inline 结果源文本登记", () => {
  test("同一次应答的多条结果共享源文本，选中任意一条都取得回", () => {
    recordInlineResultSources(7, "小号也有啊", [
      textResult("gag-a", "（透过口塞）小. .. ..号"),
      textResult("gag-b", "（透过口塞）小...号. .也"),
    ]);
    expect(inlineResultSourceOf("（透过口塞）小. .. ..号")).toBe("小号也有啊");
    expect(inlineResultSourceOf("（透过口塞）小...号. .也")).toBe("小号也有啊");
    expect(inlineResultSourceOf("（透过口塞）没登记过的正文")).toBeUndefined();
    expect(inlineResultSourceOf("")).toBeUndefined();
  });

  test("同一个查询者的新应答整体覆盖旧登记，不留历史", () => {
    recordInlineResultSources(7, "小号", [textResult("gag-a", "旧正文")]);
    recordInlineResultSources(7, "小号也有啊", [textResult("gag-a", "新正文")]);
    expect(inlineResultSourceOf("新正文")).toBe("小号也有啊");
    expect(inlineResultSourceOf("旧正文")).toBeUndefined();
    expect(inlineResultSources.size).toBe(1);
  });

  test("源文本为空、结果为空或结果不带正文的应答一律不登记", () => {
    recordInlineResultSources(7, "", [textResult("luck", "你好，@x")]);
    recordInlineResultSources(8, "所求事项", []);
    recordInlineResultSources(9, "所求事项", [
      { type: "game", id: "game", game_short_name: "g" },
    ]);
    expect(inlineResultSources.size).toBe(0);
    expect(inlineResultSourceOf("你好，@x")).toBeUndefined();
  });

  test("撑满上限时按最久未登记的查询者淘汰，重新登记的回到队尾", () => {
    for (let authorId: number = 1; authorId <= INLINE_RESULT_SOURCE_MAX_AUTHORS; authorId += 1) {
      recordInlineResultSources(authorId, `源 ${authorId}`, [
        textResult(`r-${authorId}`, `正文 ${authorId}`),
      ]);
    }
    // 最旧的那位重新查询一次：他回到队尾，被挤掉的应当是第二旧的那位。
    recordInlineResultSources(1, "源 1 改", [textResult("r-1", "正文 1 改")]);
    // 新来的必须是上面没占过的 id，否则只是覆盖、不会触发淘汰。
    const newcomerId: number = INLINE_RESULT_SOURCE_MAX_AUTHORS + 1;
    recordInlineResultSources(newcomerId, "新来的", [
      textResult(`r-${newcomerId}`, "正文 新来的"),
    ]);

    expect(inlineResultSources.size).toBe(INLINE_RESULT_SOURCE_MAX_AUTHORS);
    expect(inlineResultSourceOf("正文 新来的")).toBe("新来的");
    expect(inlineResultSourceOf("正文 1 改")).toBe("源 1 改");
    expect(inlineResultSourceOf("正文 2")).toBeUndefined();
  });
});
