/** 广告队列测试共用的 owner 状态、provider 替身与逐用例复位。 */

import { mock } from "bun:test";
import type { AdCandidateMessage } from "../../packages/types/antiRaid";
import type { AdVerdict } from "../../packages/types/antiRaid/adDetect";
import type { TelegramWorkerTemporaryMessageResult } from "../../packages/types/telegramWorker";

export const classifyAdText = mock(async (_text: string): Promise<AdVerdict | null> => ({ isAd: false, reason: "" }));
export const disposeAdSender = mock(async (..._args: unknown[]): Promise<void> => {});
let warningNow: number = 1_000;
export const warnReferencedAdSender = mock(async (): Promise<TelegramWorkerTemporaryMessageResult | undefined> => ({
  messageId: 555,
  sentAt: warningNow,
}));
export const deleteReferencedAdMessages = mock((..._args: unknown[]): void => {});
export const deleteStaleReferencedAdWarning = mock((..._args: unknown[]): void => {});
export const deleteStragglerAdMessage = mock((_chatId: number, _messageId: number): void => {});
export const classifiedTexts: string[] = [];
export const classifiedFacts: boolean[] = [];
/** 各群的管理员集合；undefined 表示缓存未命中，freshAdminIds 据此返回 undefined。 */
export const cachedAdmins: Map<number, Set<number>> = new Map<number, Set<number>>();
export const fetchedAdmins: Map<number, Set<number>> = new Map<number, Set<number>>();
export const fetchAdminIds = mock(async (chatId: number): Promise<Set<number>> => {
  const admins: Set<number> | undefined = fetchedAdmins.get(chatId);
  if (!admins) throw new Error("admin fetch failed");
  return admins;
});

export const errorLogs: string[] = [];
mock.module("../../packages/infra/logger", () => ({
  logger: {
    log(): void {},
    info(): void {},
    warn(): void {},
    error(message: unknown): void { errorLogs.push(String(message)); },
  },
}));
mock.module("../../packages/workers/antiRaid/adDetect/classifier", () => ({
  classifyAdText: async (params: { text: string; justJoined: boolean }): Promise<AdVerdict | null> => {
    classifiedTexts.push(params.text);
    classifiedFacts.push(params.justJoined);
    return classifyAdText(params.text);
  },
}));
mock.module("../../packages/workers/antiRaid/adDetect/disposal", () => ({
  disposeAdSender,
  warnReferencedAdSender,
  deleteReferencedAdMessages,
  deleteStaleReferencedAdWarning,
  deleteStragglerAdMessage,
}));
mock.module("../../packages/workers/antiRaid/adminCache", () => ({
  freshAdminIds: (chatId: number): Set<number> | undefined => cachedAdmins.get(chatId),
  fetchAdminIds,
  // 三态契约的替身；真实现由 test/workers/antiRaid/adminCache.test.ts 钉住。
  isChatAdmin: async (chatId: number, userId: number): Promise<boolean | undefined> => {
    const cached: Set<number> | undefined = cachedAdmins.get(chatId);
    if (cached !== undefined) return cached.has(userId);
    try {
      return (await fetchAdminIds(chatId)).has(userId);
    } catch {
      return undefined;
    }
  },
}));

export function setAdDetectWarningNow(value: number): void {
  warningNow = value;
}

/** 默认空姓名用于单独验证正文、引用与队列语义；姓名用例显式传入 meta。 */
export function candidate(overrides: Partial<AdCandidateMessage> = {}): AdCandidateMessage {
  return {
    type: "adCandidate",
    chatId: -1001,
    senderId: 7,
    messageId: 1,
    text: "随便聊聊",
    linkUrls: [],
    label: "@spammer",
    meta: { firstName: "", lastName: "", username: "spammer" },
    isChannel: false,
    isForwarded: false,
    blocked: false,
    justJoined: false,
    ...overrides,
  };
}

/** 复位 mock 与夹具；真实 owner 状态的清理由调用方传入，避免 helper 动态导入生产模块。 */
export function resetAdDetectQueueHarness(stopAdDetectQueue: () => void): void {
  stopAdDetectQueue();
  errorLogs.length = 0;
  classifiedTexts.length = 0;
  classifiedFacts.length = 0;
  classifyAdText.mockClear();
  classifyAdText.mockImplementation(async (): Promise<AdVerdict | null> => ({ isAd: false, reason: "" }));
  disposeAdSender.mockClear();
  warnReferencedAdSender.mockClear();
  warningNow = 1_000;
  warnReferencedAdSender.mockImplementation(async (): Promise<TelegramWorkerTemporaryMessageResult> => ({
    messageId: 555,
    sentAt: warningNow,
  }));
  deleteReferencedAdMessages.mockClear();
  deleteStaleReferencedAdWarning.mockClear();
  deleteStragglerAdMessage.mockClear();
  fetchAdminIds.mockClear();
  cachedAdmins.clear();
  fetchedAdmins.clear();
  // 默认：管理员表拿得到且目标不是管理员，处置照常走。
  fetchedAdmins.set(-1001, new Set<number>());
}
