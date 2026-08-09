import { beforeEach, describe, expect, mock, test } from "bun:test";
import { CHAT_TITLE_REFRESH_CONCURRENCY, CHAT_TITLE_REFRESH_SAVE_BATCH_SIZE } from "../../packages/consts/telegram";

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
  getAllChatStates: () => states,
  getChatState: (chatId: number) => states.get(chatId) ?? {},
  getOrCreateChatState: (chatId: number) => states.get(chatId)!,
  saveStateInBackground,
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
    // 攒批落盘：逐个群 save 会让启动期变成 O(群数²) 的主线程序列化+深校验
    // （StateStore.save 每次都对**全部**群做一遍，LatestValueRunner 只合并磁盘
    // 写、不合并这段 CPU），正好压在 runner 刚开始投喂更新的窗口上。
    expect(saveStateInBackground).toHaveBeenCalledTimes(500 / CHAT_TITLE_REFRESH_SAVE_BATCH_SIZE);
    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining("500/500"));
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

    expect(saveStateInBackground).toHaveBeenCalledTimes(1);
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
