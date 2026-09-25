import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { MessageEntity } from "grammy/types";
import type { AgentDeploymentConfig } from "../../packages/types/config";
import type { VoiceSynthesisResult } from "../../packages/types/aiChat/voiceMessage";
import type { TelegramSendResult } from "../../packages/types/telegram";

const copyMessageMock = mock(async (..._args: unknown[]): Promise<number | undefined> => 42);
const sendMessageMock = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const sendVoiceWithResultMock = mock(async (..._args: unknown[]): Promise<TelegramSendResult | undefined> => ({ messageId: 88 }));
const VOICE_BYTES: Uint8Array<ArrayBuffer> = new Uint8Array([0x4f, 0x67, 0x67, 0x53]);
const synthesizeVoiceMock = mock(async (..._args: unknown[]): Promise<VoiceSynthesisResult> => ({
  ok: true,
  voice: { bytes: VOICE_BYTES, durationSeconds: 4 },
}));
/** 延迟执行器替身：接纳的任务收进队列，由用例显式执行。 */
const deferredTasks: (() => Promise<void>)[] = [];
let deferredAccepting: boolean = true;
const submitDeferredCommandMock = mock((_priority: string, task: () => Promise<void>, _label: string): boolean => {
  if (!deferredAccepting) return false;
  deferredTasks.push(task);
  return true;
});
mock.module("../../packages/commands/deferredCommands", () => ({ submitDeferredCommand: submitDeferredCommandMock }));
mock.module("../../packages/infra/telegram", () => ({
  copyMessage: copyMessageMock,
  sendMessage: sendMessageMock,
  sendVoiceWithResult: sendVoiceWithResultMock,
  bot: { api: {} },
  logApiError: () => {},
}));

const targetChatId = -1001234567890;
let chatState: { isTranslationEnabled?: boolean } = {};
// g-auth.json 的可用性；坏掉时自动复读必须退化成普通复制，不能假装翻译过。
let jaReadiness: { ok: true } | { ok: false; failure: { file: string; reason: string } } = { ok: true };
mock.module("../../packages/config/readiness", () => ({
  translateConfigReadiness: () => jaReadiness,
  // 自动流水线同一条路径上还挂着 AI 闲聊的判定；这个文件只考 ja，让它恒通过。
  aiChatConfigReadiness: () => ({ ok: true }),
  adDetectConfigReadiness: () => ({ ok: true }),
}));
const disableChatStateSwitchMock = mock((..._args: unknown[]): boolean => true);
const persistChatStateMock = mock(async (..._args: unknown[]): Promise<void> => {});
mock.module("../../packages/infra/storage/stateStore", () => ({
  disableChatStateSwitch: disableChatStateSwitchMock,
  activeCopyTargetIdIn: (): undefined => undefined,
  persistGlobalState: async (): Promise<void> => {},
  activeCopyModeIn: (): undefined => undefined,
  getActiveProxySendTarget: () => targetChatId,
  getChatState: () => chatState,
  getOrCreateChatState: () => ({}),
  getChatStateCache: (): ReadonlyMap<number, unknown> => new Map(),
  persistChatState: persistChatStateMock,
  saveChatStateInBackground: () => {},
}));
mock.module("../../packages/infra/chatTitle", () => ({ recordChatTitleFromChat: () => {} }));
mock.module("../../packages/users/senderIdentity", () => ({ cacheSender: (message: any) => message.from?.id }));
mock.module("../../packages/aiChat", () => ({
  recordChatMessage: () => {},
  recordChatMedia: () => {},
  generateAndSendReply: () => {},
  synthesizeVoice: synthesizeVoiceMock,
}));
mock.module("../../packages/infra/selfSentTracker", () => ({
  isSelfSent: () => false,
  isBotOwnMessage: () => false,
  needsBotOwnMessageWait: () => false,
  waitForBotOwnMessage: async (): Promise<boolean> => false,
}));

const { handleIncomingMessageMiddleware } = await import("../../packages/auto/message");
const { SUPER_ADMIN_USER_ID } = await import("../../packages/config/bot");
const { adoptAgentDeploymentConfig, getAgentDeploymentConfig } = await import("../../packages/config/agent");
const { parseProxyTtsRequest } = await import("../../packages/auto/message/proxyTts");
const { VOICE_OPERATOR_TEXT_MAX_CHARS, VOICE_TONE_MAX_CHARS } = await import("../../packages/consts/aiChat/voiceMessage");
const { NOTICE_TEXTS } = await import("../../packages/consts/atmosphere/plain/notices");
const { NOTICE_TEXTS: TEASING_NOTICE_TEXTS } = await import("../../packages/consts/atmosphere/teasing/notices");
const AGENT: AgentDeploymentConfig = getAgentDeploymentConfig();

function privateMessageCtx(userId: number, text: string = "private text", entities?: MessageEntity[]): any {
  return {
    me: { id: 999999, username: "test_bot", first_name: "TestBot" },
    msg: {
      message_id: 7,
      date: 1,
      chat: { id: userId, type: "private", first_name: "User" },
      from: { id: userId, is_bot: false, first_name: "User" },
      text,
      entities,
    },
  };
}

/** 超管发来一整条代码块。 */
function codeBlockCtx(text: string, language?: string): any {
  return privateMessageCtx(SUPER_ADMIN_USER_ID, text, [{ type: "pre", offset: 0, length: text.length, language }]);
}

/** 回给超管的提示正文。 */
function noticeTexts(): string[] {
  return sendMessageMock.mock.calls.map((call: unknown[]): string => (call[0] as { text: string }).text);
}

/** 两种风格里任一种的同名提示；本文件不关心目标群用哪种风格。 */
function eitherNotice(pick: (texts: typeof NOTICE_TEXTS) => string): string[] {
  return [pick(NOTICE_TEXTS), pick(TEASING_NOTICE_TEXTS)];
}

describe("/send 私聊中转权限", () => {
  beforeEach(() => {
    chatState = {};
    jaReadiness = { ok: true };
    copyMessageMock.mockClear();
    copyMessageMock.mockImplementation(async (): Promise<number | undefined> => 42);
    sendMessageMock.mockClear();
    disableChatStateSwitchMock.mockClear();
    persistChatStateMock.mockClear();
    sendVoiceWithResultMock.mockClear();
    synthesizeVoiceMock.mockClear();
    submitDeferredCommandMock.mockClear();
    deferredTasks.length = 0;
    deferredAccepting = true;
    adoptAgentDeploymentConfig(AGENT);
  });

  test("全局会话活动时也不会复制外部用户私聊，只复制超管本人的消息", async () => {
    await handleIncomingMessageMiddleware(privateMessageCtx(SUPER_ADMIN_USER_ID + 1));
    expect(copyMessageMock).not.toHaveBeenCalled();

    await handleIncomingMessageMiddleware(privateMessageCtx(SUPER_ADMIN_USER_ID));
    expect(copyMessageMock).toHaveBeenCalledTimes(1);
    expect(copyMessageMock).toHaveBeenCalledWith({
      chatId: targetChatId,
      fromChatId: SUPER_ADMIN_USER_ID,
      messageId: 7,
    });
  });

  // copyMessage 失败时返回 undefined、不抛错。
  test("转发失败时关掉中转会话、落盘并回执，不再静默吞掉后续私聊", async () => {
    copyMessageMock.mockImplementation(async (): Promise<number | undefined> => undefined);

    await handleIncomingMessageMiddleware(privateMessageCtx(SUPER_ADMIN_USER_ID));

    expect(disableChatStateSwitchMock).toHaveBeenCalledWith(targetChatId, "isProxySendEnabled");
    expect(persistChatStateMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const notice = sendMessageMock.mock.calls[0]![0] as { chatId: number; text: string };
    expect(notice.chatId).toBe(SUPER_ADMIN_USER_ID);
    expect(notice.text).toContain(String(targetChatId));
  });

  test("转发成功时不碰会话状态，也不发回执", async () => {
    await handleIncomingMessageMiddleware(privateMessageCtx(SUPER_ADMIN_USER_ID));

    expect(disableChatStateSwitchMock).not.toHaveBeenCalled();
    expect(persistChatStateMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});

describe("/send 代发的 TTS 请求", () => {
  beforeEach(() => {
    copyMessageMock.mockClear();
    sendMessageMock.mockClear();
    sendVoiceWithResultMock.mockClear();
    sendVoiceWithResultMock.mockImplementation(async (): Promise<TelegramSendResult | undefined> => ({ messageId: 88 }));
    synthesizeVoiceMock.mockClear();
    synthesizeVoiceMock.mockImplementation(async (): Promise<VoiceSynthesisResult> => ({
      ok: true,
      voice: { bytes: VOICE_BYTES, durationSeconds: 4 },
    }));
    submitDeferredCommandMock.mockClear();
    deferredTasks.length = 0;
    deferredAccepting = true;
    disableChatStateSwitchMock.mockClear();
    adoptAgentDeploymentConfig(AGENT);
  });

  test("整条代码块按 JSONC 解析：注释与尾逗号都接受，语气拼在基础语气之后由合成侧处理", async () => {
    const request: string = `{
  "type": "tts",
  "tone": "需要的语气", // 依然拼接在基础的语气之后
  "text": "需要转换的文本",
}`;
    await handleIncomingMessageMiddleware(codeBlockCtx(request, "json"));

    expect(copyMessageMock).not.toHaveBeenCalled();
    expect(submitDeferredCommandMock).toHaveBeenCalledTimes(1);
    expect(submitDeferredCommandMock.mock.calls[0]![0]).toBe("interactive");
    expect(deferredTasks).toHaveLength(1);
    await deferredTasks[0]!();

    expect(synthesizeVoiceMock).toHaveBeenCalledWith({ text: "需要转换的文本", tone: "需要的语气", signal: undefined });
    expect(sendVoiceWithResultMock).toHaveBeenCalledWith({
      chatId: targetChatId,
      bytes: VOICE_BYTES,
      fileName: "voice.ogg",
      signal: undefined,
      duration: 4,
    });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test("不是整条代码块、解析不出 JSON 或 type 不是 tts 的消息照常代发", async () => {
    const tts: string = JSON.stringify({ type: "tts", text: "hi" });
    const cases: any[] = [
      privateMessageCtx(SUPER_ADMIN_USER_ID, tts),
      privateMessageCtx(SUPER_ADMIN_USER_ID, `x${tts}`, [{ type: "pre", offset: 1, length: tts.length }]),
      privateMessageCtx(SUPER_ADMIN_USER_ID, tts, [{ type: "code", offset: 0, length: tts.length }]),
      privateMessageCtx(SUPER_ADMIN_USER_ID, tts, [
        { type: "pre", offset: 0, length: tts.length },
        { type: "bold", offset: 0, length: 1 },
      ]),
      codeBlockCtx("{ not json"),
      codeBlockCtx(JSON.stringify({ type: "text", text: "hi" })),
      codeBlockCtx(JSON.stringify(["tts"])),
    ];
    for (const ctx of cases) await handleIncomingMessageMiddleware(ctx);
    expect(copyMessageMock).toHaveBeenCalledTimes(cases.length);
    expect(submitDeferredCommandMock).not.toHaveBeenCalled();
  });

  test.each([
    [{ type: "tts" }],
    [{ type: "tts", text: "   " }],
    [{ type: "tts", text: 1 }],
    [{ type: "tts", text: "あ".repeat(VOICE_OPERATOR_TEXT_MAX_CHARS + 1) }],
    [{ type: "tts", text: "hi", tone: "" }],
    [{ type: "tts", text: "hi", tone: null }],
    [{ type: "tts", text: "hi", tone: "あ".repeat(VOICE_TONE_MAX_CHARS + 1) }],
    [{ type: "tts", text: "hi", voice: "Leda" }],
  ])("type 为 tts 但键或取值不合规时回用法提示，不代发也不合成：%j", async (request: Record<string, unknown>) => {
    await handleIncomingMessageMiddleware(codeBlockCtx(JSON.stringify(request)));
    expect(copyMessageMock).not.toHaveBeenCalled();
    expect(submitDeferredCommandMock).not.toHaveBeenCalled();
    expect(eitherNotice((texts) => texts.proxyTtsUsage(VOICE_OPERATOR_TEXT_MAX_CHARS, VOICE_TONE_MAX_CHARS)))
      .toContain(noticeTexts()[0]!);
  });

  test("台词与语气清洗成单行；语气可省", () => {
    const message = codeBlockCtx(JSON.stringify({ type: "tts", text: " おやすみ\nまた明日 " })).msg;
    expect(parseProxyTtsRequest(message)).toEqual({ kind: "tts", text: "おやすみ また明日", tone: undefined });
    const withTone = codeBlockCtx(JSON.stringify({ type: "tts", text: "hi", tone: " 小声で\n " })).msg;
    expect(parseProxyTtsRequest(withTone)).toEqual({ kind: "tts", text: "hi", tone: "小声で" });
  });

  test("agent.tts 未配置时直接报错，不交给执行器", async () => {
    adoptAgentDeploymentConfig({ ...AGENT, tts: undefined });
    await handleIncomingMessageMiddleware(codeBlockCtx(JSON.stringify({ type: "tts", text: "hi" })));
    expect(submitDeferredCommandMock).not.toHaveBeenCalled();
    expect(copyMessageMock).not.toHaveBeenCalled();
    expect(eitherNotice((texts) => texts.proxyTtsUnconfigured)).toContain(noticeTexts()[0]!);
  });

  test("执行器已满时回「稍后再试」", async () => {
    deferredAccepting = false;
    await handleIncomingMessageMiddleware(codeBlockCtx(JSON.stringify({ type: "tts", text: "hi" })));
    expect(eitherNotice((texts) => texts.proxyTtsBusy)).toContain(noticeTexts()[0]!);
  });

  test("合成或发送失败只回一句提示，代发会话保持开启；取消时静默收尾", async () => {
    const request: any = codeBlockCtx(JSON.stringify({ type: "tts", text: "hi" }));
    synthesizeVoiceMock.mockImplementationOnce(async (): Promise<VoiceSynthesisResult> => ({ ok: false, reason: "timed out" }));
    await handleIncomingMessageMiddleware(request);
    await deferredTasks.shift()!();
    expect(sendVoiceWithResultMock).not.toHaveBeenCalled();
    expect(eitherNotice((texts) => texts.proxyTtsFailed(targetChatId))).toContain(noticeTexts()[0]!);

    sendMessageMock.mockClear();
    synthesizeVoiceMock.mockImplementationOnce(async (): Promise<VoiceSynthesisResult> => ({ ok: false, reason: "tts unconfigured" }));
    await handleIncomingMessageMiddleware(request);
    await deferredTasks.shift()!();
    expect(eitherNotice((texts) => texts.proxyTtsUnconfigured)).toContain(noticeTexts()[0]!);

    sendMessageMock.mockClear();
    sendVoiceWithResultMock.mockImplementationOnce(async (): Promise<TelegramSendResult | undefined> => undefined);
    await handleIncomingMessageMiddleware(request);
    await deferredTasks.shift()!();
    expect(eitherNotice((texts) => texts.proxyTtsFailed(targetChatId))).toContain(noticeTexts()[0]!);

    sendMessageMock.mockClear();
    synthesizeVoiceMock.mockImplementationOnce(async (): Promise<VoiceSynthesisResult> => ({ ok: false, reason: "aborted" }));
    await handleIncomingMessageMiddleware(request);
    await deferredTasks.shift()!();
    expect(sendMessageMock).not.toHaveBeenCalled();

    expect(disableChatStateSwitchMock).not.toHaveBeenCalled();
  });
});
