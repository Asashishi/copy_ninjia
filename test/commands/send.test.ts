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
mock.module("../../packages/infra/telegram", () => ({
  sendCommandMessage: sendMessageMock,
  logApiError: logApiErrorMock,
}));
mock.module("../../packages/infra/telegram/mainClient", () => ({
  bot: { api: { getChat: getChatMock } },
}));

const chatStates = new Map<number, Record<string, unknown>>();
const saveStateInBackgroundMock = mock((..._args: unknown[]): void => {});
mock.module("../../packages/infra/storage/stateStore", () => ({
  // 故意按「State 已经管满」建模：真实的 getOrCreateChatState 在 chat_states 已达
  // STATE_MANAGED_CHAT_LIMIT 时，为一个未知群新建状态会抛容量错（见
  // infra/chatStateStorage.ts 的 assertChatStateCapacity）。handleSendCommand 绝不
  // 该为未纳管的群走到这里，所以这句抛错等价于一条断言：它一旦逸出，复现的就是
  // 「一条 /send 让 update 不被确认、进程带非零码退出、Telegram 重投再抛」的
  // 重启循环。
  getOrCreateChatState: (chatId: number): Record<string, unknown> => {
    const state = chatStates.get(chatId);
    if (!state) throw new Error("chat_states must contain at most 25 chats; delete chats that are no longer managed before adding another chat.");
    return state;
  },
  getChatStateCache: (): ReadonlyMap<number, Record<string, unknown>> => chatStates,
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
  persistChatState: async (_chatId: number, context: string): Promise<void> => { saveStateInBackgroundMock(context); },
}));

const { handleSendCommand } = await import("../../packages/commands/send");
const { SUPER_ADMIN_USER_ID } = await import("../../packages/config/telegram");

function makeCtx(chatType: "private" | "group", userId: number | undefined, arg: string): any {
  return {
    chat: { id: userId ?? -100999, type: chatType },
    from: userId !== undefined ? { id: userId, username: undefined, first_name: "Test" } : undefined,
    msgId: 1,
    match: arg,
  };
}

/** 把一个群标成「已纳管」：/init enable 过的群在 chat_states 里就是这么一条记录。 */
function manage(chatId: number): void {
  chatStates.set(chatId, {});
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
    manage(-100123);
    getChatMock.mockImplementation(async (): Promise<any> => {
      throw new Error("Bad Request: chat not found");
    });
    await handleSendCommand(makeCtx("private", SUPER_ADMIN_USER_ID, "-100123"));
    expect(saveStateInBackgroundMock).not.toHaveBeenCalled();
    expect(chatStates.get(-100123)).toEqual({});
    expect(logApiErrorMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  test("可达的私人用户或频道也拒绝作为中转目标，避免私聊泄露", async () => {
    manage(-1001);
    for (const type of ["private", "channel"]) {
      getChatMock.mockImplementationOnce(async (): Promise<any> => ({ id: -1001, type, first_name: "Not a group" }));
      await handleSendCommand(makeCtx("private", SUPER_ADMIN_USER_ID, "-1001"));
    }
    expect(saveStateInBackgroundMock).not.toHaveBeenCalled();
    expect(chatStates.get(-1001)).toEqual({});
    expect(logApiErrorMock).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
  });

  // 这条命令过去在这里 getOrCreateChatState(targetChatId)：目标没纳管时那是一次
  // 新建，State 管满 25 个群时新建抛容量错，异常逸出命令处理器就是一个由重投
  // 驱动的重启循环。现在只回一句提示——容量拒绝只属于 /init enable 那一处。
  test("目标群没被纳管时只回一句提示：不抛错、不建状态、不落盘，也不探可达性", async () => {
    for (let index: number = 0; index < 25; index += 1) manage(-2_000 - index);

    await handleSendCommand(makeCtx("private", SUPER_ADMIN_USER_ID, "-100123"));

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(chatStates.has(-100123)).toBe(false);
    expect(chatStates.size).toBe(25);
    expect(getChatMock).not.toHaveBeenCalled();
    expect(saveStateInBackgroundMock).not.toHaveBeenCalled();
  });

  test("非规范写法的 id 按用法错误挡在可达性探测之前，绝不开会话", async () => {
    // 裸 Number() 会把这些悄悄收下：小数尾巴、十六进制、前导零各自 coerce 成
    // 一个超管从没输入过的 chat id，而这条命令的结果是一个持久代发会话。
    // 正数同样拒绝：群和频道的 id 恒为负。
    for (const arg of ["-100123.0", "0x2d", "123", "-0100123", "-1e5", "--100123"]) {
      await handleSendCommand(makeCtx("private", SUPER_ADMIN_USER_ID, arg));
    }
    expect(getChatMock).not.toHaveBeenCalled();
    expect(saveStateInBackgroundMock).not.toHaveBeenCalled();
    expect(chatStates.size).toBe(0);
    expect(sendMessageMock).toHaveBeenCalledTimes(6);
  });

  test("合法且可达的群组 id 开启会话并落盘（状态挂在目标群自己的 chatId 下）；重复调用被拒绝、不换目标", async () => {
    manage(-100123);
    manage(-100456);
    await handleSendCommand(makeCtx("private", SUPER_ADMIN_USER_ID, "-100123"));
    expect(getChatMock).toHaveBeenCalledTimes(1);
    expect(chatStates.get(-100123)).toEqual({ isProxySendEnabled: true });
    expect(saveStateInBackgroundMock).toHaveBeenCalledTimes(1);

    await handleSendCommand(makeCtx("private", SUPER_ADMIN_USER_ID, "-100456"));
    expect(chatStates.get(-100123)).toEqual({ isProxySendEnabled: true });
    expect(chatStates.get(-100456)).toEqual({}); // 已纳管但没被开成第二个目标
    expect(saveStateInBackgroundMock).toHaveBeenCalledTimes(1); // 被拒绝的这次没有再落盘
    expect(getChatMock).toHaveBeenCalledTimes(1); // 已经在转发就不必再探一次可达性
  });

  test("finish 结束会话并落盘（清掉目标群自己的 isProxySendEnabled）；没有会话时 finish 只提示、不落盘", async () => {
    manage(-100123);
    await handleSendCommand(makeCtx("private", SUPER_ADMIN_USER_ID, "finish"));
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(saveStateInBackgroundMock).not.toHaveBeenCalled();

    await handleSendCommand(makeCtx("private", SUPER_ADMIN_USER_ID, "-100123"));
    await handleSendCommand(makeCtx("private", SUPER_ADMIN_USER_ID, "finish"));
    expect(chatStates.get(-100123)).toBeUndefined();
    expect(saveStateInBackgroundMock).toHaveBeenCalledTimes(2);
  });
});
