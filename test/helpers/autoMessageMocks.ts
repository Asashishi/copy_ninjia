/**
 * `auto/message` 消息流水线测试共用的模块桩、可调旋钮与逐用例复位。
 *
 * 这一族用例（身份传递、贴纸回复、语音转写……）驱动的都是同一个
 * `handleIncomingMessage`，因此都要把同一批模块挡在外面：Telegram 出站、群状态、
 * 群标题记录、发送者缓存、AI Worker 投递、自发消息判定。统一安装完整边界，
 * 避免各文件桩面不一致；桩面随生产模块一起维护。
 *
 * 形态照 `test/helpers/adDetectQueueHarness.ts`：import 期登记 `mock.module`，
 * 因此**必须在被测生产模块之前 import**（各用例文件用顶层 `await import` 拿生产
 * 模块，天然满足）。差异通过导出的 mock 与旋钮配置。
 */

import { mock } from "bun:test";

export const recordChatMessageMock = mock((..._args: unknown[]): void => {});
export const recordChatMediaMock = mock((..._args: unknown[]): void => {});
export const generateAndSendReplyMock = mock((..._args: unknown[]): void => {});
export const copyMessageMock = mock(
  async (..._args: unknown[]): Promise<number | undefined> => undefined
);
export const sendMessageMock = mock(
  async (..._args: unknown[]): Promise<number | undefined> => undefined
);
export const isBotOwnMessageMock = mock((..._args: unknown[]): boolean => false);
export const needsBotOwnMessageWaitMock = mock((..._args: unknown[]): boolean => false);
export const waitForBotOwnMessageMock = mock(
  async (..._args: unknown[]): Promise<boolean> => false
);

/**
 * 各用例可改的群状态旋钮；`getChatState` 每次读现值，改完立即生效。
 *
 * 静默存的是**相对偏移**而不是绝对时刻：`isQuietUntilActive` 同时判上界
 * （`quietUntil - now` 不得超过 QUIET_MAX_DURATION_MS + 容差），写一个很远的
 * 绝对时刻反而会被判成「未静默」。
 */
export const autoMessageChatState: {
  isAIChatEnabled: boolean;
  /**
   * 本群是否已接管。缺省 false：问答直答那条分支只对已接管的群生效，不关心它的
   * 用例保持原有走向（见 auto/message/index.ts）。
   */
  isInitEnabled: boolean;
  /** 距现在的静默剩余毫秒；undefined 表示从没设过静默。 */
  quietUntilOffsetMs: number | undefined;
} = { isAIChatEnabled: true, isInitEnabled: false, quietUntilOffsetMs: 60_000 };

/**
 * 本群已登记的问答；空表等价于「这个群没开问答」，`getChatQa` 返回 undefined，
 * 直答链路在第一行就走开（口径同 infra/qaStore.ts）。
 */
export const autoMessageQaEntries: Map<string, string> = new Map<string, string>();

mock.module("../../packages/infra/telegram", () => ({
  copyMessage: copyMessageMock,
  sendMessage: sendMessageMock,
  bot: { api: {} },
  logApiError: (): void => {},
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  clearChatStateField: (): boolean => false,
  activeCopyTargetIdIn: (): undefined => undefined,
  activeCopyModeIn: (): undefined => undefined,
  getActiveProxySendTarget: (): undefined => undefined,
  getChatState: (): Record<string, unknown> => ({
    isAIChatEnabled: autoMessageChatState.isAIChatEnabled,
    isInitEnabled: autoMessageChatState.isInitEnabled,
    quietUntil: autoMessageChatState.quietUntilOffsetMs === undefined
      ? undefined
      : Date.now() + autoMessageChatState.quietUntilOffsetMs,
  }),
  getOrCreateChatState: (): Record<string, unknown> => ({}),
  persistChatState: async (): Promise<void> => {},
  saveChatStateInBackground: (): void => {},
}));
// 直答查表是主干上的一步；真实 qaStore 会把 Disk I/O 宿主一并拉进来。
mock.module("../../packages/infra/qaStore", () => ({
  getChatQa: (): ReadonlyMap<string, string> | undefined =>
    autoMessageQaEntries.size === 0 ? undefined : autoMessageQaEntries,
}));
mock.module("../../packages/infra/chatTitle", () => ({
  recordChatTitleFromChat: (): void => {},
}));
mock.module("../../packages/users/senderIdentity", () => ({
  cacheSender: (message: any): number | undefined =>
    message.sender_chat?.id ?? message.from?.id,
}));
mock.module("../../packages/aiChat", () => ({
  recordChatMessage: recordChatMessageMock,
  recordChatMedia: recordChatMediaMock,
  generateAndSendReply: generateAndSendReplyMock,
}));
mock.module("../../packages/infra/selfSentTracker", () => ({
  isSelfSent: (): boolean => false,
  isBotOwnMessage: isBotOwnMessageMock,
  needsBotOwnMessageWait: needsBotOwnMessageWaitMock,
  waitForBotOwnMessage: waitForBotOwnMessageMock,
}));

/** 逐用例复位：清空调用记录、恢复默认实现、把旋钮拨回缺省。 */
export function resetAutoMessageMocks(): void {
  recordChatMessageMock.mockClear();
  recordChatMediaMock.mockClear();
  generateAndSendReplyMock.mockClear();
  copyMessageMock.mockClear();
  copyMessageMock.mockImplementation(async (): Promise<number | undefined> => undefined);
  sendMessageMock.mockClear();
  sendMessageMock.mockImplementation(async (): Promise<number | undefined> => undefined);
  isBotOwnMessageMock.mockClear();
  isBotOwnMessageMock.mockImplementation((): boolean => false);
  needsBotOwnMessageWaitMock.mockClear();
  needsBotOwnMessageWaitMock.mockImplementation((): boolean => false);
  waitForBotOwnMessageMock.mockClear();
  waitForBotOwnMessageMock.mockImplementation(async (): Promise<boolean> => false);
  autoMessageChatState.isAIChatEnabled = true;
  autoMessageChatState.isInitEnabled = false;
  autoMessageChatState.quietUntilOffsetMs = 60_000;
  autoMessageQaEntries.clear();
}
