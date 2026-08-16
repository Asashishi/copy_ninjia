import { beforeEach, describe, expect, mock, test } from "bun:test";
import { CHAT_TITLE_REFRESH_CONCURRENCY } from "../../packages/consts/telegram";
import { STATE_MANAGED_CHAT_LIMIT } from "../../packages/consts/storage";

const states = new Map<number, { isInitEnabled: true; title?: string }>();
const saveStateInBackground = mock((_context: string): void => {});
const getChat = mock(async (_chatId: number, _signal?: AbortSignal): Promise<{
  type: "supergroup";
  title: string;
}> => ({ type: "supergroup", title: "title" }));
const loggerInfo = mock((..._args: unknown[]): void => {});
const loggerError = mock((..._args: unknown[]): void => {});

mock.module("../../packages/infra/telegram/mainClient", () => ({ bot: { api: { getChat } } }));
mock.module("../../packages/infra/logger", () => ({
  logger: { log(): void {}, warn(): void {}, info: loggerInfo, error: loggerError },
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getChatStateCache: () => states,
  getChatState: (chatId: number) => states.get(chatId) ?? {},
  getOrCreateChatState: (chatId: number) => states.get(chatId)!,
  saveChatStateInBackground: (_chatId: number, context: string): void => { saveStateInBackground(context); },
}));

const {
  abortChatTitleRefresh,
  initChatTitleRefresh,
  refreshAllChatTitles,
} = await import("../../packages/infra/chatTitle");

beforeEach(() => {
  states.clear();
  getChat.mockClear();
  saveStateInBackground.mockClear();
  loggerInfo.mockClear();
  loggerError.mockClear();
  initChatTitleRefresh();
});

describe("chat title maintenance", () => {
  test("25 个受管 chat 使用固定小并发池并全部独立结算", async () => {
    for (let chatId: number = 1; chatId <= STATE_MANAGED_CHAT_LIMIT; chatId++) {
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

    expect(getChat).toHaveBeenCalledTimes(STATE_MANAGED_CHAT_LIMIT);
    expect(maxActive).toBeLessThanOrEqual(CHAT_TITLE_REFRESH_CONCURRENCY);
    // 每条标题只编码本群并入 Worker 事务缓冲，不再重复序列化全量群快照。
    expect(saveStateInBackground).toHaveBeenCalledTimes(STATE_MANAGED_CHAT_LIMIT);
    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining(`${STATE_MANAGED_CHAT_LIMIT}/${STATE_MANAGED_CHAT_LIMIT}`));
  });

  test("标题没变化的群不触发落盘", async () => {
    for (let chatId: number = 1; chatId <= 100; chatId++) {
      states.set(chatId, { isInitEnabled: true, title: `chat-${chatId}` });
    }
    getChat.mockImplementation(async (chatId: number) => ({
      type: "supergroup" as const,
      title: `chat-${chatId}`,
    }));

    await refreshAllChatTitles();

    expect(saveStateInBackground).not.toHaveBeenCalled();
  });

  test("不足一批的尾巴在收尾时落盘，不会留在内存里", async () => {
    for (let chatId: number = 1; chatId <= 3; chatId++) {
      states.set(chatId, { isInitEnabled: true });
    }
    getChat.mockImplementation(async (chatId: number) => ({
      type: "supergroup" as const,
      title: `chat-${chatId}`,
    }));

    await refreshAllChatTitles();

    expect(saveStateInBackground).toHaveBeenCalledTimes(3);
    expect(states.get(3)?.title).toBe("chat-3");
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
