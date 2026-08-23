import { describe, expect, test } from "bun:test";
import {
  CHAT_QA_ANSWER_MAX_CHARS,
  CHAT_QA_MAX_PER_CHAT,
  CHAT_QA_QUESTION_MAX_CHARS,
} from "../../packages/consts/qa";
import {
  assertChatQaQuestion,
  decodeChatQaData,
  encodeChatQaData,
} from "../../packages/database/codec/chatQa";
import { decodeStoredChatQa } from "../../packages/database/validation/storageRows";
import type { StoredChatQaRow } from "../../packages/types/storageDatabase";

const SOURCE: string = "db:chat_qa[-1001]";

function row(chatId: number, q: string, a: string): StoredChatQaRow {
  return { chatId, q, data: JSON.stringify({ a }) };
}

describe("chat_qa codec", () => {
  test("问题必须非空、无首尾空白且不超长", () => {
    expect(() => assertChatQaQuestion("怎么入群？", SOURCE)).not.toThrow();
    expect(() => assertChatQaQuestion("", SOURCE)).toThrow();
    // 带首尾空白的键让直答查表与用户看到的文本对不上：用户永远打不出这种串。
    expect(() => assertChatQaQuestion(" 怎么入群？", SOURCE)).toThrow();
    expect(() => assertChatQaQuestion("怎么入群？ ", SOURCE)).toThrow();
    expect(() => assertChatQaQuestion("a".repeat(CHAT_QA_QUESTION_MAX_CHARS + 1), SOURCE))
      .toThrow();
  });

  test("编码与解码共用同一组上限：写得进去的一定读得回来", () => {
    const encoded: string = encodeChatQaData("点置顶那条链接", SOURCE);

    expect(decodeChatQaData(encoded, SOURCE)).toEqual({ a: "点置顶那条链接" });
    expect(() => encodeChatQaData("", SOURCE)).toThrow();
    expect(() => encodeChatQaData("a".repeat(CHAT_QA_ANSWER_MAX_CHARS + 1), SOURCE)).toThrow();
  });

  test("未知字段、缺字段与类型不符一律拒绝", () => {
    expect(() => decodeChatQaData(JSON.stringify({ a: "x", extra: 1 }), SOURCE)).toThrow();
    expect(() => decodeChatQaData(JSON.stringify({}), SOURCE)).toThrow();
    expect(() => decodeChatQaData(JSON.stringify({ a: 1 }), SOURCE)).toThrow();
    expect(() => decodeChatQaData("not json", SOURCE)).toThrow();
  });

  test("整表解码按群归并", () => {
    const decoded: ReadonlyMap<number, ReadonlyMap<string, string>> = decodeStoredChatQa(
      [row(-1001, "a", "1"), row(-1001, "b", "2"), row(-1002, "c", "3")],
      SOURCE
    );

    expect(decoded.get(-1001)?.size).toBe(2);
    expect(decoded.get(-1001)?.get("b")).toBe("2");
    expect(decoded.get(-1002)?.get("c")).toBe("3");
  });

  test("库里已有的行越界同样拒绝：不依赖主线程准入", () => {
    const rows: StoredChatQaRow[] = [];
    for (let index: number = 0; index <= CHAT_QA_MAX_PER_CHAT; index++) {
      rows.push(row(-1001, `问题${index}`, "答案"));
    }

    // 手工改库或从别处恢复的备份都可能带进越界数据，而那会让 /set_qa 从此
    // 永远拒绝新增却看不出原因。
    expect(() => decodeStoredChatQa(rows, SOURCE))
      .toThrow(`at most ${CHAT_QA_MAX_PER_CHAT} entries per chat`);
  });

  test("非法群 id 与非法问题在整表解码时就被拦下", () => {
    expect(() => decodeStoredChatQa([row(0, "a", "1")], SOURCE)).toThrow();
    expect(() => decodeStoredChatQa([row(-1001, " a", "1")], SOURCE)).toThrow();
  });
});
