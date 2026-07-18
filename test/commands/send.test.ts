import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * commands/send.ts 经 infra/telegram 会实例化真实的 grammY Bot、经
 * infra/storage 的 saveStateInBackground 会真的写项目根目录下的
 * state.json——单测里都要 mock 掉，绝不能让测试把真实状态文件覆盖掉，
 * 也不能让开会话前的 getChat 可达性校验打真实 Telegram API。infra/storage
 * 这里用一份简化的内存实现代替（只保留 getOrCreateChatState/
 * getActiveProxySendTarget/saveStateInBackground 三个 handleSendCommand
 * 用到的接口，getActiveProxySendTarget 复刻真实实现的扫描语义），比只
 * mock 掉 infra/diskIO 再用真实 storage.ts 更直接、也更安全。
 */
const sendMessageMock = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const getChatMock = mock(async (chatId: number): Promise<any> => ({ id: chatId, type: "supergroup", title: "Test Group" }));
const logApiErrorMock = mock((..._args: unknown[]): void => {});
mock.module("../../src/infra/telegram", () => ({
  sendMessage: sendMessageMock,
  bot: { api: { getChat: getChatMock } },
  logApiError: logApiErrorMock,
}));

const chatStates = new Map<number, Record<string, unknown>>();
const saveStateInBackgroundMock = mock((..._args: unknown[]): void => {});
mock.module("../../src/infra/storage/stateStore", () => ({
  getOrCreateChatState: (chatId: number): Record<string, unknown> => {
    let state = chatStates.get(chatId);
    if (!state) {
      state = {};
      chatStates.set(chatId, state);
    }
    return state;
  },
  getActiveProxySendTarget: (): number | undefined => {
    for (const [chatId, state] of chatStates) {
      if (state.isProxySendEnabled === true) return chatId;
    }
    return undefined;
  },
  clearChatStateField: (chatId: number, field: string): boolean => {
    const state = chatStates.get(chatId);
    if (!state || !(field in state)) return false;
    delete state[field];
    if (Object.keys(state).length === 0) chatStates.delete(chatId);
    return true;
  },
  saveStateInBackground: saveStateInBackgroundMock,
}));

const { handleSendCommand } = await import("../../src/commands/send");
const { SUPER_ADMIN_USER_ID } = await import("../../src/infra/config");

function makeCtx(chatType: "private" | "group", userId: number | undefined, arg: string): any {
  return {
    chat: { id: userId ?? -100999, type: chatType },
    from: userId !== undefined ? { id: userId, username: undefined, first_name: "Test" } : undefined,
    msgId: 1,
    match: arg,
  };
}

describe("handleSendCommand", () => {
  beforeEach(() => {
    chatStates.clear();
    sendMessageMock.mockClear();
    saveStateInBackgroundMock.mockClear();
    getChatMock.mockClear();
    logApiErrorMock.mockClear();
    getChatMock.mockImplementation(async (chatId: number): Promise<any> => ({ id: chatId, type: "supergroup", title: "Test Group" }));
  });

  test("群里调用不作任何回应，也不开启会话，不落盘", async () => {
    await handleSendCommand(makeCtx("group", SUPER_ADMIN_USER_ID, "-100123"));
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(saveStateInBackgroundMock).not.toHaveBeenCalled();
    expect(chatStates.size).toBe(0);
  });

  test("非超管私聊调用保持沉默，不回应、不开启会话——不能反过来向探测者确认指令存在", async () => {
    await handleSendCommand(makeCtx("private", SUPER_ADMIN_USER_ID + 1, "-100123"));
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(saveStateInBackgroundMock).not.toHaveBeenCalled();
  });

  test("参数不是合法数字时提示用法，不开启会话", async () => {
    await handleSendCommand(makeCtx("private", SUPER_ADMIN_USER_ID, "abc"));
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(saveStateInBackgroundMock).not.toHaveBeenCalled();
    expect(getChatMock).not.toHaveBeenCalled();
  });

  test("目标聊天不可达时拒绝开启会话，不落盘", async () => {
    getChatMock.mockImplementation(async (): Promise<any> => {
      throw new Error("Bad Request: chat not found");
    });
    await handleSendCommand(makeCtx("private", SUPER_ADMIN_USER_ID, "-100123"));
    expect(saveStateInBackgroundMock).not.toHaveBeenCalled();
    expect(chatStates.get(-100123)).toBeUndefined();
    expect(logApiErrorMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  test("可达的私人用户或频道也拒绝作为中转目标，避免私聊泄露", async () => {
    for (const type of ["private", "channel"]) {
      getChatMock.mockImplementationOnce(async (): Promise<any> => ({ id: 123, type, first_name: "Not a group" }));
      await handleSendCommand(makeCtx("private", SUPER_ADMIN_USER_ID, "123"));
    }
    expect(saveStateInBackgroundMock).not.toHaveBeenCalled();
    expect(chatStates.size).toBe(0);
    expect(logApiErrorMock).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
  });

  test("合法且可达的群组 id 开启会话并落盘（状态挂在目标群自己的 chatId 下）；重复调用被拒绝、不换目标", async () => {
    await handleSendCommand(makeCtx("private", SUPER_ADMIN_USER_ID, "-100123"));
    expect(getChatMock).toHaveBeenCalledTimes(1);
    expect(chatStates.get(-100123)).toEqual({ isProxySendEnabled: true });
    expect(saveStateInBackgroundMock).toHaveBeenCalledTimes(1);

    await handleSendCommand(makeCtx("private", SUPER_ADMIN_USER_ID, "-100456"));
    expect(chatStates.get(-100123)).toEqual({ isProxySendEnabled: true });
    expect(chatStates.has(-100456)).toBe(false);
    expect(saveStateInBackgroundMock).toHaveBeenCalledTimes(1); // 被拒绝的这次没有再落盘
    expect(getChatMock).toHaveBeenCalledTimes(1); // 已经在转发就不必再探一次可达性
  });

  test("finish 结束会话并落盘（清掉目标群自己的 isProxySendEnabled）；没有会话时 finish 只提示、不落盘", async () => {
    await handleSendCommand(makeCtx("private", SUPER_ADMIN_USER_ID, "finish"));
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(saveStateInBackgroundMock).not.toHaveBeenCalled();

    await handleSendCommand(makeCtx("private", SUPER_ADMIN_USER_ID, "-100123"));
    await handleSendCommand(makeCtx("private", SUPER_ADMIN_USER_ID, "finish"));
    expect(chatStates.get(-100123)).toBeUndefined();
    expect(saveStateInBackgroundMock).toHaveBeenCalledTimes(2);
  });
});
