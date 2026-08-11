/**
 * `/gag` 三个用例文件（参数渲染、状态机、消息与 inline 入口）共用的替身与工厂。
 *
 * 单文件曾经超过 1000 行（AGENTS.md 要求必须拆分），而这套 mock.module 装配、
 * 会话工厂与隔离钩子三份用例都要用；抽到这里之后各文件只保留自己的断言。
 * 每个文件都要在顶层调用一次 installGagTestHooks()。
 */

import { afterEach, beforeEach, mock } from "bun:test";
import type {
  InlineKeyboardMarkup,
  Message,
  MessageEntity,
} from "@grammyjs/types";
import { GAG_INLINE_CHANNEL_LINK_PREFIX } from "../../packages/consts/gag";
import { GAG_THUMBNAIL_URL } from "../../packages/consts/ui/assets";
import type { CachedUser } from "../../packages/types/chatState";
import type { GagSession } from "../../packages/types/gag";
import { settleTestBatch } from "../libs/helpers";
// 这两个模块不在被替身覆盖的范围内（只依赖 consts/types/libs），因此可以静态
// 导入；被测的 packages/commands/gag 必须由各用例文件在本模块的 mock.module
// 生效之后自行 await import，静态导入会抢在替身安装之前把真实依赖钉死。
import * as rendering from "../../packages/commands/gag/rendering";
import {
  activeGagSessionCount,
  gagBackgroundTasks,
  gagRuntimeAccepting,
  gagSessionCount,
  gagSessionsByChat,
} from "../../packages/cache/main/gag";

export {
  activeGagSessionCount,
  gagBackgroundTasks,
  gagSessionCount,
  gagSessionsByChat,
  rendering,
};

export interface TextMessageParams {
  readonly chatId: number;
  readonly text: string;
  readonly replyToMessageId?: number;
  readonly keyboard?: InlineKeyboardMarkup;
  readonly onSent?: (messageId: number) => void;
}

export interface EphemeralMessageParams extends TextMessageParams {
  readonly receiverUserId: number;
}

export interface EphemeralDeletionParams {
  readonly chatId: number;
  readonly receiverUserId: number;
  readonly ephemeralMessageId: number;
}

export type InlineResult = Record<string, unknown>;
export type InlineAnswerOptions = Record<string, unknown>;

export const sendCommandMessage = mock(async (_params: TextMessageParams): Promise<number | undefined> => 56);
export const sendMessage = mock(async (_params: TextMessageParams): Promise<number | undefined> => 56);
export const sendEphemeralMessage = mock(async (_params: EphemeralMessageParams): Promise<number | undefined> => 57);
export const deleteEphemeralMessageWithOutcome = mock(async (_params: EphemeralDeletionParams): Promise<string> => "deleted");
export const deleteMessageWithOutcome = mock(async (_chatId: number, _messageId: number): Promise<string> => "deleted");
export const probeChatMembership = mock(async (_chatId: number, _userId: number): Promise<boolean | undefined> => true);
export const resolveCommandTarget = mock(async (_params: unknown): Promise<CachedUser | undefined> => ({
  id: 7,
  first_name: "Alice",
  username: "alice",
}));
export const answerInlineQuery = mock(async (
  _results: readonly InlineResult[],
  _options: InlineAnswerOptions,
  _signal?: unknown
): Promise<void> => undefined);
/** 三个开关由用例直接改写；mock 出口在每次调用时读取当前值。 */
export const gagTestSwitches: {
  permissionAllowed: boolean;
  initEnabled: boolean;
  canDeleteMessages: boolean;
} = { permissionAllowed: true, initEnabled: true, canDeleteMessages: true };

mock.module("../../packages/infra/botAdmin", () => ({
  botChatPermissionsIn: async (): Promise<Readonly<{ canDeleteMessages: boolean; canRestrictMembers: boolean }>> => ({
    canDeleteMessages: gagTestSwitches.canDeleteMessages,
    canRestrictMembers: true,
  }),
}));
mock.module("../../packages/infra/chatTeardown", () => ({
  registerChatTeardown: (): void => undefined,
}));
mock.module("../../packages/infra/logger", () => ({
  logger: { error(): void {}, info(): void {}, log(): void {}, warn(): void {} },
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getChatState: (): Readonly<{ isInitEnabled: boolean }> => ({ isInitEnabled: gagTestSwitches.initEnabled }),
  getGagThumbnailUrl: (): string => GAG_THUMBNAIL_URL,
}));
mock.module("../../packages/infra/telegram", () => ({
  deleteEphemeralMessageWithOutcome,
  deleteMessageWithOutcome,
  logApiError: (): void => undefined,
  probeChatMembership,
  sendCommandMessage,
  sendEphemeralMessage,
  sendMessage,
}));
mock.module("../../packages/commands/commandActor", () => ({
  hasCommandPermission: (): boolean => gagTestSwitches.permissionAllowed,
  resolveCommandActor: (): CachedUser => ({ id: 100, first_name: "Admin" }),
}));
mock.module("../../packages/commands/targetResolution", () => ({ resolveCommandTarget }));

const originalDateNow: () => number = Date.now;

/**
 * 入口换新是 fire-and-forget 的后台任务（见 commands/gag/inline.ts：在 ingress
 * 里 await 一次 Telegram 往返会阻塞整个 update 循环）。断言换新结果前先把这批
 * 任务排空，等价于生产里 drainGagRuntime 的那一步。
 */
export async function settleGagBackgroundTasks(): Promise<void> {
  while (gagBackgroundTasks.size > 0) {
    await settleTestBatch([...gagBackgroundTasks]);
  }
}

export interface ContextOverrides {
  readonly chatId?: number;
  readonly chatType?: "group" | "supergroup" | "private";
  readonly match?: string;
  readonly replyToMessage?: Message;
}

export function commandContext({
  chatId = -1001,
  chatType = "supergroup",
  match = "@alice 5",
  replyToMessage,
}: ContextOverrides = {}): never {
  const message: Record<string, unknown> = {
    message_id: 10,
    chat: { id: chatId, type: chatType },
    from: { id: 100, first_name: "Admin" },
  };
  if (replyToMessage !== undefined) message.reply_to_message = replyToMessage;
  return {
    chat: { id: chatId, type: chatType, title: "测试群" },
    from: { id: 100, first_name: "Admin" },
    me: { id: 999, username: "test_bot" },
    msg: message,
    msgId: 10,
    match,
  } as never;
}

export interface SessionOverrides {
  readonly chatId?: number;
  readonly targetId?: number;
  readonly tool?: string;
  readonly phase?: GagSession["phase"];
  readonly expiresAt?: number;
  readonly publicNoticeMessageId?: number;
  readonly speakNoticeMessageId?: number;
  readonly pendingSpeakNoticeMessageId?: number;
  readonly retiredSpeakNoticeMessageId?: number;
  readonly messagesSinceSpeakNotice?: number;
  readonly inlineToken?: string;
}

export function createSession({
  chatId = -1001,
  targetId = 7,
  tool = "口塞",
  phase = "active",
  expiresAt = 1_300_000,
  publicNoticeMessageId,
  speakNoticeMessageId,
  pendingSpeakNoticeMessageId = 0,
  retiredSpeakNoticeMessageId = 0,
  messagesSinceSpeakNotice = 0,
  inlineToken = "0123456789abcdef",
}: SessionOverrides = {}): GagSession {
  return {
    chatId,
    targetId,
    targetLabel: "Alice (@alice)",
    chatLabel: `群 ${chatId}`,
    inlineToken,
    tool,
    durationMinutes: 5,
    phase,
    expiresAt,
    publicNoticeMessageId:
      publicNoticeMessageId ?? (targetId > 0 ? 54 : 0),
    speakNoticeMessageId:
      speakNoticeMessageId ?? (targetId > 0 ? 55 : 54),
    pendingSpeakNoticeMessageId,
    retiredSpeakNoticeMessageId,
    messagesSinceSpeakNotice,
    speakNoticeRefreshTask: null,
    noticePending: false,
    timer: null,
    cleanupRetryIndex: 0,
    cleanupTimer: null,
    endingTask: null,
  };
}

export function addSession(session: GagSession): void {
  const sessions: GagSession[] | undefined = gagSessionsByChat.get(session.chatId);
  if (sessions === undefined) gagSessionsByChat.set(session.chatId, [session]);
  else sessions.push(session);
}

export function sessionFor(chatId: number, targetId: number = 7): GagSession | undefined {
  return gagSessionsByChat.get(chatId)?.find((session: GagSession): boolean =>
    session.targetId === targetId
  );
}

export function gagInlineEntities(session: GagSession): MessageEntity[] {
  const prefix: string = rendering.gagSpeechPrefix(session.tool);
  if (session.targetId > 0) return [];
  return [{
    type: "text_link",
    offset: 0,
    length: prefix.length,
    url: `${GAG_INLINE_CHANNEL_LINK_PREFIX}${session.targetId}`,
  }];
}

export function normalMessage(overrides: Record<string, unknown> = {}): Message {
  return {
    message_id: 88,
    chat: { id: -1001, type: "supergroup", title: "测试群" },
    date: 1,
    from: { id: 7, is_bot: false, first_name: "Alice" },
    text: "普通消息",
    ...overrides,
  } as Message;
}

export function lastCommandText(): string {
  return (sendCommandMessage.mock.calls.at(-1)?.[0] as { text: string }).text;
}

export function lastStateText(): string {
  return (sendMessage.mock.calls.at(-1)?.[0] as { text: string }).text;
}

export function lastEphemeralText(): string {
  return (sendEphemeralMessage.mock.calls.at(-1)?.[0] as { text: string }).text;
}

/**
 * 清空会话表、在途后台任务与全部 timer。等价于 commands/gag/runtime.ts 的
 * resetGagSessions，但只碰 cache/main/gag，因此不必先 await import 被测模块。
 */
export function resetGagTestState(): void {
  for (const sessions of gagSessionsByChat.values()) {
    for (const session of sessions) {
      if (session.timer !== null) clearTimeout(session.timer);
      if (session.cleanupTimer !== null) clearTimeout(session.cleanupTimer);
      session.timer = null;
      session.cleanupTimer = null;
    }
  }
  gagSessionsByChat.clear();
  gagBackgroundTasks.clear();
  gagRuntimeAccepting.current = true;
}

/**
 * 三个 gag 用例文件共用的隔离钩子。拆文件之后每份都必须重新登记，否则会话表、
 * Date.now 替身与 mock 实现会跨用例泄漏。
 */
export function installGagTestHooks(): void {
  beforeEach(() => {
    resetGagTestState();
    gagTestSwitches.permissionAllowed = true;
    gagTestSwitches.initEnabled = true;
    gagTestSwitches.canDeleteMessages = true;
    Date.now = (): number => 1_000_000;
    for (const mocked of [
      deleteEphemeralMessageWithOutcome,
      sendCommandMessage,
      sendEphemeralMessage,
      sendMessage,
      deleteMessageWithOutcome,
      probeChatMembership,
      resolveCommandTarget,
      answerInlineQuery,
    ]) mocked.mockClear();
    sendCommandMessage.mockImplementation(async (_params: TextMessageParams): Promise<number | undefined> => 56);
    sendEphemeralMessage.mockImplementation(async (_params: EphemeralMessageParams): Promise<number | undefined> => 57);
    deleteEphemeralMessageWithOutcome.mockImplementation(async (_params: EphemeralDeletionParams): Promise<string> => "deleted");
    sendMessage.mockImplementation(async (_params: TextMessageParams): Promise<number | undefined> => 56);
    deleteMessageWithOutcome.mockImplementation(async (_chatId: number, _messageId: number): Promise<string> => "deleted");
    probeChatMembership.mockImplementation(async (_chatId: number, _userId: number): Promise<boolean | undefined> => true);
    resolveCommandTarget.mockImplementation(async (_params: unknown): Promise<CachedUser | undefined> => ({
      id: 7,
      first_name: "Alice",
      username: "alice",
    }));
  });

  afterEach(() => {
    resetGagTestState();
    Date.now = originalDateNow;
  });
}
