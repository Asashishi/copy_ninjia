import { describe, expect, test } from "bun:test";
import { decodeChatStateData, encodeChatStateData } from "../../packages/database/codec/chatState";
import { decodeGlobalStateFile } from "../../packages/libs/stateFileCodec";
import type { TranslateState } from "../../packages/types/translate";
import { chatStateOf } from "../helpers/chatState";

const SOURCE: string = "chat_states[-1001].status";

/** 以一份只含翻译会话的 status 解码。 */
function decodeSessions(translate: unknown): readonly TranslateState[] | undefined {
  return decodeChatStateData(JSON.stringify({ isTranslationEnabled: true, translate }), SOURCE).translate;
}

describe("chat_states 里的翻译会话", () => {
  test("每群允许五个不同目标，空数组、六人、单会话对象和重复身份拒绝", () => {
    const sessions: TranslateState[] = [];
    for (let id: number = 1; id <= 5; id++) sessions.push({ translatedUser: { id }, language: "uk" });
    expect(decodeSessions(sessions)).toHaveLength(5);
    for (const invalid of [[], [...sessions, { translatedUser: { id: 6 }, language: "ru" }], sessions[0]]) {
      expect(() => decodeSessions(invalid)).toThrow("$.translate must be an array containing 1 to 5 translation sessions");
    }
    expect(() => decodeSessions([sessions[0], sessions[0]])).toThrow("$.translate[1].translatedUser.id must be unique within the chat");
  });

  test("缺省的 translate 解码为 undefined，编码时不写入该键", () => {
    expect(decodeChatStateData('{"isTranslationEnabled":true}', SOURCE).translate).toBeUndefined();
    expect(encodeChatStateData(chatStateOf({ isTranslationEnabled: true }))).toBe('{"isTranslationEnabled":true}');
  });

  test("方向与身份字段严格往返", () => {
    const sessions: readonly TranslateState[] = [
      { translatedUser: { id: 7, username: "alice" }, language: "ja" },
      { translatedUser: { id: -3003, title: "Channel", isChannel: true }, language: "cn" },
      { translatedUser: { id: 8, first_name: "Bob", last_name: "Lee" }, language: "en" },
      { translatedUser: { id: 9 }, language: "uk" },
      { translatedUser: { id: 10 }, language: "ru" },
    ];
    const text: string = encodeChatStateData(chatStateOf({ isTranslationEnabled: true, translate: sessions }));
    const decoded: readonly TranslateState[] | undefined = decodeChatStateData(text, SOURCE).translate;
    expect(decoded?.map((session: TranslateState): string => session.language)).toEqual(["ja", "cn", "en", "uk", "ru"]);
    expect(decoded?.[0]?.translatedUser.username).toBe("alice");
    expect(decoded?.[1]?.translatedUser.isChannel).toBeTrue();
    expect(decoded?.[2]?.translatedUser.last_name).toBe("Lee");
  });

  test.each([
    null,
    {},
    { translatedUser: { id: 7 } },
    { translatedUser: { id: 7 }, language: "zh" },
    { translatedUser: { id: 7 }, language: null },
    { translatedUser: { id: 0 }, language: "en" },
    { translatedUser: { id: "secret" }, language: "cn" },
    { translatedUser: null, language: "ja" },
    { translatedUser: { id: 7 }, language: "ja", copyMode: "ja" },
    { translatedUser: { id: 7, token: "secret" }, language: "ja" },
  ])("非法会话整行拒绝，不丢弃或默认修复", (entry: unknown) => {
    expect(() => decodeSessions([entry])).toThrow("$.translate[0]");
  });

  test.each(["ua", "UK", "RU", "list", "secret"])("方向 %s 拒绝解析且错误只包含字段路径和期望", (language: string) => {
    expect(() => decodeSessions([{ translatedUser: { id: 7 }, language }]))
      .toThrow(`${SOURCE}: $.translate[0].language must be one of ja, cn, en, uk or ru.`);
  });
});

describe("全局状态文件不保存翻译会话", () => {
  test("顶层 translate 块一律拒绝", () => {
    for (const translate of [{}, { "-1001": [{ translatedUser: { id: 7 }, language: "ja" }] }]) {
      expect(() => decodeGlobalStateFile({ copy: { copiedUser: null }, translate }, "state.json"))
        .toThrow("state.json: $.translate must be absent (not part of the current state schema).");
    }
  });
});
