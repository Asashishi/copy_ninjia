import { beforeEach, describe, expect, mock, test } from "bun:test";
import { CHAT_TITLE_REFRESH_CONCURRENCY } from "../../src/consts/telegram";

const states = new Map<number, { isInitEnabled: true; title?: string }>();
const saveStateInBackground = mock((_context: string): void => {});
const getChat = mock(async (_chatId: number, _signal?: AbortSignal): Promise<{
  type: "supergroup";
  title: string;
}> => ({ type: "supergroup", title: "title" }));
const loggerInfo = mock((..._args: unknown[]): void => {});
const loggerError = mock((..._args: unknown[]): void => {});

mock.module("../../src/infra/telegram", () => ({ bot: { api: { getChat } } }));
mock.module("../../src/infra/logger", () => ({
  logger: { log(): void {}, warn(): void {}, info: loggerInfo, error: loggerError },
}));
mock.module("../../src/infra/storage/stateStore", () => ({
  getAllChatStates: () => states,
  getChatState: (chatId: number) => states.get(chatId) ?? {},
  getOrCreateChatState: (chatId: number) => states.get(chatId)!,
  saveStateInBackground,
}));

const {
  abortChatTitleRefresh,
  initChatTitleRefresh,
  refreshAllChatTitles,
} = await import("../../src/infra/chatTitle");

beforeEach(() => {
  states.clear();
  getChat.mockClear();
  saveStateInBackground.mockClear();
  loggerInfo.mockClear();
  loggerError.mockClear();
  initChatTitleRefresh();
});

describe("chat title maintenance", () => {
  test("500 个历史 chat 使用固定小并发池并全部独立结算", async () => {
    for (let chatId: number = 1; chatId <= 500; chatId++) {
      states.set(chatId, { isInitEnabled: true });
    }
    let active: number = 0;
    let maxActive: number = 0;
    getChat.mockImplementation(async (chatId: number) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(0);
      active--;
      return { type: "supergroup" as const, title: `chat-${chatId}` };
    });

    await refreshAllChatTitles();

    expect(getChat).toHaveBeenCalledTimes(500);
    expect(maxActive).toBeLessThanOrEqual(CHAT_TITLE_REFRESH_CONCURRENCY);
    expect(saveStateInBackground).toHaveBeenCalledTimes(500);
    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining("500/500"));
  });

  test("abort 后不再保存悬挂请求的迟到结果", async () => {
    states.set(1, { isInitEnabled: true });
    let resolveChat!: () => void;
    getChat.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { resolveChat = resolve; });
      return { type: "supergroup" as const, title: "late-title" };
    });

    const refresh = refreshAllChatTitles();
    await Bun.sleep(0);
    abortChatTitleRefresh();
    resolveChat();
    await refresh;

    expect(saveStateInBackground).not.toHaveBeenCalled();
    expect(states.get(1)?.title).toBeUndefined();
  });
});
