import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CachedUser, GlobalCopyState } from "../../packages/types/chatState";
import type { TranslateLanguage, TranslateState } from "../../packages/types/translate";
import type { SendCommandMessageParams } from "../../packages/infra/telegram/commandMessages";
import { translateStates } from "../../packages/cache/main/translateState";
import { STATE_MANAGED_CHAT_LIMIT } from "../../packages/consts/storage";
import { TRANSLATE_CAPACITY_TEXT, TRANSLATE_CHAT_CAPACITY_TEXT, TRANSLATE_TARGET_TEXTS } from "../../packages/consts/translate";
import { teardownRegisteredChat } from "../../packages/infra/chatTeardownRegistry";
import { loggerStub } from "../helpers/loggerMock";

const sendCommandMessage = mock(async (..._args: unknown[]): Promise<number> => 1);
const persistGlobalState = mock(async (..._args: unknown[]): Promise<void> => {});
const persistChatState = mock(async (..._args: unknown[]): Promise<void> => {});
const copySideEffect = mock((): void => {});
const seedSenderCache = mock((..._args: unknown[]): void => {});
let target: CachedUser | undefined = { id: 7, first_name: "Target" };
let configured: boolean = true;
let allowed: boolean = true;
const state: { isTranslationEnabled?: boolean } = {};
const globalCopy: GlobalCopyState = { copiedUser: { id: 8 }, copyChatId: -2002, copyMode: "nya", lastCopyTime: Date.now() };
const resolveCommandTarget = mock(async (..._args: unknown[]): Promise<CachedUser | undefined> => target);
mock.module("../../packages/infra/telegram", () => ({ sendCommandMessage }));
mock.module("../../packages/infra/logger", () => ({ logger: loggerStub() }));
mock.module("../../packages/config/readiness", () => ({
  translateConfigReadiness: () => configured ? { ok: true } : { ok: false, failure: { file: "g-auth.json", reason: "Invalid g-auth.json" } },
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getChatState: () => state,
  getOrCreateChatState: () => state,
  getGlobalCopyState: () => globalCopy,
  persistGlobalState,
  persistChatState,
}));
mock.module("../../packages/commands/targetResolution", () => ({ resolveCommandTarget }));
mock.module("../../packages/users/senderIdentity", () => ({ seedSenderCache }));
mock.module("../../packages/commands/copyShared", () => ({
  claimCopyCooldownOrReject: copySideEffect,
  stealAvatarInBackground: copySideEffect,
  restoreAvatarInBackground: copySideEffect,
}));
mock.module("../../packages/infra/identityPolicy/whitelist", () => ({ hasWhitelistPermission: () => allowed }));
const { handleTranslateCommand } = await import("../../packages/commands/translate");
const { setTranslateState } = await import("../../packages/translate/state");
const { seedTranslateTargets } = await import("../../packages/translate/recovery");

function context(argument: string, chatId: number = -1001): never {
  return {
    chat: { id: chatId }, msgId: 9, match: argument,
    me: { id: 999, username: "test_bot" },
    from: { id: 100, first_name: "Caller" },
    msg: { message_id: 9, chat: { id: chatId, type: "supergroup" } },
  } as never;
}

beforeEach(() => {
  translateStates.clear();
  state.isTranslationEnabled = true;
  target = { id: 7, first_name: "Target" };
  configured = true;
  allowed = true;
  sendCommandMessage.mockClear();
  persistGlobalState.mockReset();
  persistGlobalState.mockResolvedValue(undefined);
  persistChatState.mockReset();
  persistChatState.mockResolvedValue(undefined);
  copySideEffect.mockClear();
  seedSenderCache.mockClear();
  resolveCommandTarget.mockClear();
});

describe("/translate 独立命令", () => {
  test("每群最多五个目标，第六人拒绝且不影响既有会话", async () => {
    for (let id: number = 1; id <= 5; id++) {
      target = { id };
      await handleTranslateCommand(context("uk"));
    }
    const previous: readonly TranslateState[] | undefined = translateStates.get(-1001);
    target = { id: 6 };
    await handleTranslateCommand(context("ru"));
    expect(translateStates.get(-1001)).toBe(previous);
    expect(previous).toHaveLength(5);
    expect(sendCommandMessage.mock.calls.at(-1)?.[0]).toMatchObject({ text: TRANSLATE_CHAT_CAPACITY_TEXT });
    expect(persistGlobalState).toHaveBeenCalledTimes(5);
    await handleTranslateCommand(context("ru", -2002));
    expect(translateStates.get(-2002)).toHaveLength(1);
  });

  test.each(["stop", "stop @Alice", "stop 7", "stop -3003"])("%s 指定目标时仅停止单人，配置失效仍可停止", async (argument: string) => {
    const id: number = argument === "stop -3003" ? -3003 : 7;
    target = { id };
    setTranslateState(-1001, { translatedUser: { id }, language: "uk" });
    const other: TranslateState = { translatedUser: { id: 8 }, language: "ru" };
    setTranslateState(-1001, other);
    const ctx = context(argument) as any;
    if (argument === "stop") ctx.msg.reply_to_message = { from: { id } };
    configured = false;
    await handleTranslateCommand(ctx);
    expect(resolveCommandTarget).toHaveBeenCalledWith({
      chatId: -1001, message: ctx.msg, botUserId: 999, rawArgument: argument.slice(4).trim(),
      messages: TRANSLATE_TARGET_TEXTS, acceptUserId: true, acceptChatId: true,
    });
    expect(translateStates.get(-1001)).toEqual([other]);
    expect(translateStates.get(-1001)?.[0]).toBe(other);
    expect(persistGlobalState).toHaveBeenCalledTimes(1);
  });

  test("目标解析失败不停止全群，单人重复停止仍确认持久化", async () => {
    setTranslateState(-1001, { translatedUser: { id: 8 }, language: "ru" });
    target = undefined;
    await handleTranslateCommand(context("stop @Unknown"));
    expect(translateStates.get(-1001)).toHaveLength(1);
    expect(persistGlobalState).not.toHaveBeenCalled();
    target = { id: 7 };
    await handleTranslateCommand(context("stop 7"));
    expect(translateStates.get(-1001)).toHaveLength(1);
    expect(persistGlobalState).toHaveBeenCalledTimes(1);
    expect(sendCommandMessage.mock.calls.at(-1)?.[0]).toMatchObject({ text: expect.stringContaining("本来就没在用翻译") });
  });

  test("所有方向各群独立，活动 copy 与头像冷却不阻挡翻译", async () => {
    const copyBefore: string = JSON.stringify(globalCopy);
    for (const [chatId, language, label] of [
      [-1001, "ja", "日语"], [-2002, "cn", "简体中文"], [-3003, "en", "美式英语"],
      [-4004, "uk", "乌克兰语"], [-5005, "ru", "俄语"],
    ] as const) {
      await handleTranslateCommand(context(language, chatId));
      expect(translateStates.get(chatId)).toEqual([{ translatedUser: { id: 7, first_name: "Target" }, language }]);
      expect(sendCommandMessage.mock.calls.at(-1)?.[0]).toMatchObject({ text: expect.stringContaining(`翻成${label}`) });
    }
    expect(JSON.stringify(globalCopy)).toBe(copyBefore);
    expect(copySideEffect).not.toHaveBeenCalled();
    expect(persistGlobalState).toHaveBeenCalledTimes(5);
  });

  test.each(["en", "uk", "ru"] as const)("%s 方向参数先消费，用户名和回复交给共享目标解析", async (language: TranslateLanguage) => {
    const ctx = context(`${language} @Alice`);
    await handleTranslateCommand(ctx);
    expect(resolveCommandTarget).toHaveBeenCalledWith({
      chatId: -1001, message: (ctx as any).msg, botUserId: 999,
      rawArgument: "@Alice", messages: TRANSLATE_TARGET_TEXTS,
    });
  });

  test("list 使用 JSON 代码块列出所有方向，功能关闭、配置缺失和无管理权限时仍可查看", async () => {
    configured = false;
    allowed = false;
    state.isTranslationEnabled = false;
    const previous: TranslateState = { translatedUser: { id: 7 }, language: "uk" };
    translateStates.set(-1001, [previous]);
    await handleTranslateCommand(context("list"));
    expect(sendCommandMessage).toHaveBeenCalledTimes(1);
    const message: SendCommandMessageParams = sendCommandMessage.mock.calls[0]?.[0] as SendCommandMessageParams;
    expect(message.entities).toEqual([{ type: "pre", offset: 0, length: message.text.length, language: "json" }]);
    expect(JSON.parse(message.text)).toEqual({ ja: "日语", cn: "简体中文", en: "美式英语", uk: "乌克兰语", ru: "俄语" });
    expect(message.text).toContain('\n  "uk": "乌克兰语"');
    expect(message.text).not.toContain("```");
    expect(message.chatId).toBe(-1001);
    expect(message.replyToMessageId).toBe(9);
    expect(message.preserveInGroup).toBeUndefined();
    expect(translateStates.get(-1001)?.[0]).toBe(previous);
    expect(resolveCommandTarget).not.toHaveBeenCalled();
    expect(persistGlobalState).not.toHaveBeenCalled();
    expect(persistChatState).not.toHaveBeenCalled();
  });

  test.each(["ua", "UK", "RU", "uk/ru", "list extra", "list @Alice"])("非法参数 %s 不进入目标解析或修改会话", async (argument: string) => {
    await handleTranslateCommand(context(argument));
    expect(resolveCommandTarget).not.toHaveBeenCalled();
    expect(translateStates.size).toBe(0);
    expect(persistGlobalState).not.toHaveBeenCalled();
    expect(sendCommandMessage.mock.calls[0]?.[0]).toMatchObject({ text: expect.stringContaining("/translate list") });
  });

  test.each(["", "@alice", "zh", "cn/en", "ja extra tokens", "stop extra", "enable extra"])("参数 %s 无效时不创建会话", async (argument: string) => {
    target = undefined;
    await handleTranslateCommand(context(argument));
    expect(translateStates.size).toBe(0);
    expect(persistGlobalState).not.toHaveBeenCalled();
  });

  test("同一目标的活动方向不会被覆盖，其他目标可同时开启", async () => {
    await handleTranslateCommand(context("ja"));
    const previous: TranslateState | undefined = translateStates.get(-1001)?.[0];
    await handleTranslateCommand(context("cn"));
    expect(translateStates.get(-1001)?.[0]).toBe(previous);
    expect(persistGlobalState).toHaveBeenCalledTimes(1);
    expect(sendCommandMessage.mock.calls.at(-1)?.[0]).toMatchObject({ text: expect.stringContaining("/translate stop") });
    target = { id: 88 };
    await handleTranslateCommand(context("uk"));
    expect(translateStates.get(-1001)).toHaveLength(2);
    expect(translateStates.get(-1001)?.[0]).toBe(previous);
    expect(translateStates.get(-1001)?.[1]?.language).toBe("uk");
  });

  test("stop 只停止本群，无头像或 copy 副作用，配置失效后仍可停止", async () => {
    await handleTranslateCommand(context("ja"));
    await handleTranslateCommand(context("en", -2002));
    configured = false;
    await handleTranslateCommand(context("stop"));
    expect(translateStates.has(-1001)).toBe(false);
    expect(translateStates.has(-2002)).toBe(true);
    expect(globalCopy.copiedUser?.id).toBe(8);
    expect(copySideEffect).not.toHaveBeenCalled();
  });

  test("落盘完成前不发送开始或停止成功回执，失败原样上抛", async () => {
    const deferred = Promise.withResolvers<void>();
    persistGlobalState.mockImplementationOnce(() => deferred.promise);
    const starting = handleTranslateCommand(context("ja"));
    await Bun.sleep(0);
    expect(translateStates.has(-1001)).toBe(true);
    expect(sendCommandMessage).not.toHaveBeenCalled();
    deferred.resolve();
    await starting;
    sendCommandMessage.mockClear();
    persistGlobalState.mockRejectedValueOnce(new Error("disk failed"));
    await expect(handleTranslateCommand(context("stop"))).rejects.toThrow("disk failed");
    expect(sendCommandMessage).not.toHaveBeenCalled();
  });

  test("关闭功能需要翻译权限，获授权后删除本群会话", async () => {
    await handleTranslateCommand(context("ja"));
    allowed = false;
    await handleTranslateCommand(context("disable"));
    expect(translateStates.has(-1001)).toBe(true);
    expect(persistChatState).not.toHaveBeenCalled();
    allowed = true;
    await handleTranslateCommand(context("disable"));
    expect(translateStates.has(-1001)).toBe(false);
    expect(state.isTranslationEnabled).toBe(false);
  });

  test("配置不可用和功能缺省关闭都拒绝开始", async () => {
    configured = false;
    await handleTranslateCommand(context("ja"));
    configured = true;
    state.isTranslationEnabled = undefined;
    await handleTranslateCommand(context("en"));
    expect(resolveCommandTarget).not.toHaveBeenCalled();
    expect(translateStates.size).toBe(0);
  });

  test("关闭开关前等待会话删除落盘，失败不更新开关且不回执成功", async () => {
    await handleTranslateCommand(context("ja"));
    sendCommandMessage.mockClear();
    const pending = Promise.withResolvers<void>();
    persistGlobalState.mockImplementationOnce(() => pending.promise);
    const disabling = handleTranslateCommand(context("disable"));
    await Bun.sleep(0);
    expect(translateStates.has(-1001)).toBe(false);
    expect(state.isTranslationEnabled).toBe(true);
    expect(persistChatState).not.toHaveBeenCalled();
    expect(sendCommandMessage).not.toHaveBeenCalled();
    pending.reject(new Error("session write failed"));
    await expect(disabling).rejects.toThrow("session write failed");
    expect(state.isTranslationEnabled).toBe(true);
    expect(sendCommandMessage).not.toHaveBeenCalled();
    await handleTranslateCommand(context("disable"));
    expect(state.isTranslationEnabled).toBe(false);
    expect(persistGlobalState).toHaveBeenCalledTimes(3);
  });

  test("会话删除持久化完成后才写 SQLite；开关落盘失败不恢复会话", async () => {
    await handleTranslateCommand(context("ja"));
    sendCommandMessage.mockClear();
    const order: string[] = [];
    persistGlobalState.mockImplementationOnce(async (): Promise<void> => { order.push("session"); });
    persistChatState.mockImplementationOnce(async (): Promise<void> => {
      order.push("switch");
      throw new Error("switch write failed");
    });
    await expect(handleTranslateCommand(context("disable"))).rejects.toThrow("switch write failed");
    expect(order).toEqual(["session", "switch"]);
    expect(translateStates.has(-1001)).toBe(false);
    expect(sendCommandMessage).not.toHaveBeenCalled();
    await handleTranslateCommand(context("enable"));
    expect(translateStates.has(-1001)).toBe(false);
  });

  test("teardown 先同步关闭会话，再等待落盘", async () => {
    await handleTranslateCommand(context("ja"));
    const deferred = Promise.withResolvers<void>();
    persistGlobalState.mockImplementationOnce(() => deferred.promise);
    const stopping = teardownRegisteredChat("translate", -1001, "lostAuthority");
    expect(translateStates.has(-1001)).toBe(false);
    deferred.resolve();
    await stopping;
  });

  test("容量拒绝第 26 群且不淘汰活动会话；恢复目标复用身份缓存", async () => {
    for (let index: number = 1; index <= STATE_MANAGED_CHAT_LIMIT; index++) {
      setTranslateState(-index, { translatedUser: { id: index }, language: "ja" });
    }
    expect(setTranslateState(-1001, { translatedUser: { id: 50 }, language: "en" })).toBe(false);
    expect(() => setTranslateState(1001, { translatedUser: { id: 50 }, language: "en" })).toThrow("negative");
    expect(translateStates.size).toBe(STATE_MANAGED_CHAT_LIMIT);
    await handleTranslateCommand(context("en"));
    expect(sendCommandMessage).toHaveBeenCalledWith({ chatId: -1001, text: TRANSLATE_CAPACITY_TEXT, replyToMessageId: 9 });
    expect(persistGlobalState).not.toHaveBeenCalled();
    expect(setTranslateState(-1, { translatedUser: { id: 50 }, language: "en" })).toBe(true);
    seedTranslateTargets();
    expect(seedSenderCache).toHaveBeenCalledTimes(STATE_MANAGED_CHAT_LIMIT + 1);
  });
});
