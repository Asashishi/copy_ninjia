import { afterEach, describe, expect, test } from "bun:test";
import { decodeStateFile } from "../../packages/libs/stateFileCodec";
import { STATE_MANAGED_CHAT_LIMIT } from "../../packages/consts/storage";
import { stateStoreHolder, globalCopyState } from "../../packages/cache/main/storage";
import { translateStates } from "../../packages/cache/main/translateState";
import { loadState, persistGlobalState, StateStore } from "../../packages/infra/storage/stateStore";
import type { TranslateState } from "../../packages/types/translate";

afterEach(() => {
  stateStoreHolder.current?.dispose();
  stateStoreHolder.current = null;
  translateStates.clear();
  globalCopyState.copiedUser = null;
  globalCopyState.copyMode = undefined;
  globalCopyState.copyChatId = undefined;
  globalCopyState.lastCopyTime = undefined;
});

function stateFile(translate?: unknown): unknown {
  return {
    global: { copy: { copiedUser: null, lastCopyTime: 1_234 } },
    translate,
  };
}

describe("可选的 translate 状态", () => {
  test("每群允许五个不同目标，空数组、六人、重复身份和单会话旧格式拒绝启动", () => {
    const sessions: TranslateState[] = [];
    for (let id: number = 1; id <= 5; id++) sessions.push({ translatedUser: { id }, language: "uk" });
    expect(decodeStateFile(stateFile({ "-1001": sessions })).translate["-1001"]).toHaveLength(5);
    for (const invalid of [[], [...sessions, { translatedUser: { id: 6 }, language: "ru" }], sessions[0]]) {
      expect(() => decodeStateFile(stateFile({ "-1001": invalid }))).toThrow("an array containing 1 to 5");
    }
    expect(() => decodeStateFile(stateFile({ "-1001": [sessions[0], sessions[0]] }))).toThrow("must be unique within the chat");
  });

  test("缺字段可直接启动解析，新增空块不改变已有 global 内容", () => {
    const original = { global: { copy: { copiedUser: null, lastCopyTime: 1_234 } } };
    const before = decodeStateFile(original);
    const after = decodeStateFile({ ...original, translate: {} });
    expect(before).toEqual(after);
    expect(after.translate).toEqual({});
    expect(after.global.copy.lastCopyTime).toBe(1_234);
  });

  test("方向和身份按群恢复，不写进 copy", () => {
    const decoded = decodeStateFile(stateFile({
      "-1001": [{ translatedUser: { id: 7, username: "alice" }, language: "ja" }],
      "-2002": [{ translatedUser: { id: -3003, title: "Channel", isChannel: true }, language: "cn" }],
      "-4004": [{ translatedUser: { id: 8 }, language: "en" }],
      "-5005": [{ translatedUser: { id: 9 }, language: "uk" }],
      "-6006": [{ translatedUser: { id: 10 }, language: "ru" }],
    }));
    expect(decoded.translate["-1001"]?.[0]?.translatedUser.id).toBe(7);
    expect(decoded.translate["-2002"]?.[0]?.language).toBe("cn");
    expect(decoded.translate["-4004"]?.[0]?.language).toBe("en");
    expect(decoded.translate["-5005"]?.[0]?.language).toBe("uk");
    expect(decoded.translate["-6006"]?.[0]?.language).toBe("ru");
    expect(decoded.global.copy.copiedUser).toBeNull();
  });

  test.each([[null], [[]], [false], ["secret"]])("存在但非法的 translate 块拒绝解析", (value: unknown) => {
    expect(() => decodeStateFile(stateFile(value))).toThrow("state.translate must be an object");
  });

  test.each(["0", "1001", "-01", "-1e3", "-9007199254740992", "__proto__", "secret"])("群键 %s 不合法时拒绝且不回显键值", (key: string) => {
    expect(() => decodeStateFile(stateFile({ [key]: { translatedUser: { id: 7 }, language: "ja" } })))
      .toThrow("state.translate keys must be canonical negative safe integer Telegram group IDs");
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
  ])("非法会话整份拒绝，不丢弃或默认修复", (entry: unknown) => {
    expect(() => decodeStateFile(stateFile({ "-1001": [entry] }))).toThrow("state.translate.-1001");
  });

  test.each(["ua", "UK", "RU", "list", "secret"])("方向 %s 拒绝解析且错误只包含字段路径和期望", (language: string) => {
    expect(() => decodeStateFile(stateFile({ "-1001": [{ translatedUser: { id: 7 }, language }] })))
      .toThrow("state.translate.-1001[0].language must be one of ja, cn, en, uk or ru");
  });

  test("copy 不再接受翻译模式；新会话超过容量时拒绝启动", () => {
    expect(() => decodeStateFile({ global: { copy: { copiedUser: { id: 7 }, copyChatId: -1001, copyMode: "ja" } } }))
      .toThrow("state.global.copy.copyMode must be one of reverse or nya");
    const entries: Record<string, readonly TranslateState[]> = {};
    for (let index: number = 1; index <= STATE_MANAGED_CHAT_LIMIT + 1; index++) {
      entries[String(-index)] = [{ translatedUser: { id: index }, language: "ja" }];
    }
    expect(() => decodeStateFile(stateFile(entries))).toThrow("state.translate must contain at most");
  });

  test("从现行无 translate 文件恢复后落盘会添加空块，主备均保留 global", async () => {
    const original: string = JSON.stringify(stateFile());
    const writes: Map<string, string> = new Map<string, string>();
    stateStoreHolder.current = new StateStore({
      stateFilePath: "/virtual/state.json",
      backupFilePath: "/virtual/state.json.bak",
      readText: async (): Promise<string> => original,
      writeText: async (path: string, content: string): Promise<void> => { writes.set(path, content); },
    });
    await loadState();
    await persistGlobalState("test additive translate state");
    for (const path of ["/virtual/state.json", "/virtual/state.json.bak"]) {
      const written = JSON.parse(writes.get(path)!);
      expect(written.translate).toEqual({});
      expect(written.global.copy).toEqual({ copiedUser: null, lastCopyTime: 1_234 });
    }
  });

  test("持久化后重载各群会话，缺字段不沿用旧内存条目", async () => {
    let contents: string = JSON.stringify(stateFile({
      "-1001": [{ translatedUser: { id: 7, username: "alice" }, language: "ja" }],
      "-2002": [{ translatedUser: { id: 8 }, language: "en" }],
      "-3003": [{ translatedUser: { id: 9 }, language: "uk" }, { translatedUser: { id: 11 }, language: "ru" }],
      "-4004": [{ translatedUser: { id: 10 }, language: "ru" }],
    }));
    stateStoreHolder.current = new StateStore({
      stateFilePath: "/virtual/state.json",
      backupFilePath: "/virtual/state.json.bak",
      readText: async (): Promise<string> => contents,
      writeText: async (_path: string, text: string): Promise<void> => { contents = text; },
    });
    await loadState();
    expect(translateStates.get(-1001)?.[0]?.translatedUser.username).toBe("alice");
    expect(translateStates.get(-2002)?.[0]?.language).toBe("en");
    expect(translateStates.get(-3003)?.[0]?.language).toBe("uk");
    expect(translateStates.get(-3003)?.[1]?.language).toBe("ru");
    expect(translateStates.get(-4004)?.[0]?.language).toBe("ru");
    translateStates.delete(-1001);
    await persistGlobalState("test translation stop");
    translateStates.clear();
    await loadState();
    expect(translateStates.has(-1001)).toBe(false);
    expect(translateStates.has(-2002)).toBe(true);
    expect(translateStates.get(-3003)?.[0]?.language).toBe("uk");
    expect(translateStates.get(-3003)?.[1]?.language).toBe("ru");
    expect(translateStates.get(-4004)?.[0]?.language).toBe("ru");
    contents = JSON.stringify(stateFile());
    await loadState();
    expect(translateStates.size).toBe(0);
  });
});
