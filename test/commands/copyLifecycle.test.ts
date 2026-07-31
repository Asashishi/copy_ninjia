import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CachedUser } from "../../packages/types/chatState";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const saveStateInBackground = mock((..._args: unknown[]): void => {});
const releaseCopyCooldownClaim = mock((..._args: unknown[]): void => {});
const stealAvatarInBackground = mock((..._args: unknown[]): void => {});
let cooldownRejected: boolean = false;
let target: CachedUser | undefined;
const claim = { rejected: false as const, previousLastCopyTime: undefined, claimedAt: 123 };
const globalCopy: {
  copiedUser: CachedUser | null;
  copyMode?: string;
  copyChatId?: number;
} = { copiedUser: null };
let jaEnabled: boolean = true;
// g-auth.json 的可用性；坏掉时 /ja_copy 必须点名文件而不是让翻译静默失败。
let jaReadiness: { ok: true } | { ok: false; failure: { file: string; reason: string } } = { ok: true };

const claimCopyCooldownOrReject = mock(async () => cooldownRejected ? { rejected: true as const } : claim);
const resolveCopyCommandTarget = mock(async (): Promise<CachedUser | undefined> => target);

const loggerError = mock((..._args: unknown[]): void => {});
mock.module("../../packages/infra/logger", () => ({ logger: { error: loggerError } }));
mock.module("../../packages/config/readiness", () => ({
  jaTranslateConfigReadiness: () => jaReadiness,
}));
mock.module("../../packages/infra/telegram", () => ({
  sendCommandMessage: sendMessage,
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getChatState: () => ({ isJATranslationEnabled: jaEnabled }),
  getGlobalCopyState: () => globalCopy,
  persistAuthoritativeState: async (...args: unknown[]): Promise<void> => { saveStateInBackground(...args); },
  saveStateInBackground,
}));
mock.module("../../packages/commands/copyShared", () => ({
  claimCopyCooldownOrReject,
  releaseCopyCooldownClaim,
  resolveCopyCommandTarget,
  stealAvatarInBackground,
}));

const { handleCopyCommand, handleStopCommand } = await import("../../packages/commands/copy");
const { handleStealIconCommand } = await import("../../packages/commands/stealIcon");

function context(chatId: number = -1001, replyToUserId?: number): never {
  return {
    chat: { id: chatId },
    from: { id: 8, first_name: "Caller" },
    msgId: 9,
    // 槽位占用分支用 peekCommandTarget 只读地看一眼目标（回复优先），因此
    // 这里必须是一条真实形状的消息。
    msg: {
      message_id: 9,
      date: 1,
      chat: { id: chatId, type: "supergroup" },
      reply_to_message: replyToUserId === undefined ? undefined : {
        message_id: 8,
        date: 1,
        chat: { id: chatId, type: "supergroup" },
        from: { id: replyToUserId, is_bot: false, first_name: `User${replyToUserId}` },
      },
    },
    match: "",
  } as never;
}

beforeEach(() => {
  cooldownRejected = false;
  target = { id: 7, first_name: "Alice", username: "alice" };
  jaEnabled = true;
  jaReadiness = { ok: true };
  loggerError.mockClear();
  globalCopy.copiedUser = null;
  delete globalCopy.copyMode;
  delete globalCopy.copyChatId;
  for (const mocked of [
    sendMessage,
    saveStateInBackground,
    releaseCopyCooldownClaim,
    stealAvatarInBackground,
    claimCopyCooldownOrReject,
    resolveCopyCommandTarget,
  ]) mocked.mockClear();
});

describe("copy 类命令生命周期", () => {
  test("日语功能关闭或全局冷却拒绝时不解析目标", async () => {
    jaEnabled = false;
    await handleCopyCommand(context(), "ja");
    expect(claimCopyCooldownOrReject).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    jaEnabled = true;
    cooldownRejected = true;
    await handleCopyCommand(context());
    expect(resolveCopyCommandTarget).not.toHaveBeenCalled();
  });

  test("服务账号密钥坏掉时 /ja_copy 点名文件，而不是让翻译静默退化成原文", async () => {
    // 本群开着（密钥是后来才坏的）：仍必须拒绝。翻译失败的降级是静默的
    // ——原样发出未翻译的原文，群里看不出与「翻译服务抖了一下」的区别。
    jaReadiness = { ok: false, failure: { file: "g-auth.json", reason: "Invalid g-auth.json: boom" } };
    await handleCopyCommand(context(), "ja");

    expect(claimCopyCooldownOrReject).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("g-auth.json"),
      replyToMessageId: 9,
    });
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("Invalid g-auth.json"));
  });

  test("密钥可用时其余 copy 模式不受这道判定影响", async () => {
    jaReadiness = { ok: false, failure: { file: "g-auth.json", reason: "Invalid g-auth.json: boom" } };
    await handleCopyCommand(context(), "nya");

    expect(claimCopyCooldownOrReject).toHaveBeenCalledTimes(1);
  });

  test("目标解析失败或已有复制目标时回滚本次冷却占位", async () => {
    target = undefined;
    await handleCopyCommand(context());
    expect(releaseCopyCooldownClaim).toHaveBeenCalledWith(claim);

    target = { id: 7, first_name: "Alice" };
    globalCopy.copiedUser = { id: 7, first_name: "Alice" };
    await handleCopyCommand(context(-1001, 7));
    expect(releaseCopyCooldownClaim).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("早就在复读"),
      replyToMessageId: 9,
    });

    target = { id: 8, first_name: "Bob" };
    await handleCopyCommand(context(-1001, 8));
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("先 /stop_copy"),
      replyToMessageId: 9,
    });
  });

  test("槽位被占时只回一条拒绝，不触发带发送副作用的目标解析", async () => {
    // 走完整解析的话，参数是未缓存的 @username 时它会自己发一条「@x 都还没
    // 说过话呢」然后返回 undefined——用户收到的是「不认识这个用户名」，而真正
    // 的原因（正在复读别人）永远没说出口。
    globalCopy.copiedUser = { id: 7, first_name: "Alice" };

    await handleCopyCommand(context());

    expect(resolveCopyCommandTarget).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("先 /stop_copy"),
      replyToMessageId: 9,
    });
  });

  test("成功启动立即写全局状态，头像更新留在受控后台任务", async () => {
    await handleCopyCommand(context(), "reverse");

    expect(globalCopy).toEqual({
      copiedUser: { id: 7, first_name: "Alice", username: "alice" },
      copyMode: "reverse",
      copyChatId: -1001,
    });
    expect(saveStateInBackground).toHaveBeenCalledWith("copy started");
    expect(stealAvatarInBackground).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: -1001,
      text: expect.stringContaining("倒过来念"),
      replyToMessageId: 9,
    });
  });

  test("两个群并发启动时第二个在目标解析完成前就被全局占位拒绝", async () => {
    let resolveFirstTarget: ((value: CachedUser) => void) | undefined;
    resolveCopyCommandTarget.mockImplementationOnce(async () => await new Promise<CachedUser>((resolve) => {
      resolveFirstTarget = resolve;
    }));

    const first = handleCopyCommand(context(-1001));
    await Bun.sleep(0);
    await handleCopyCommand(context(-1002));

    expect(sendMessage).toHaveBeenCalledWith({
      chatId: -1002,
      text: expect.stringContaining("正在处理另一条 /copy"),
      replyToMessageId: 9,
    });
    resolveFirstTarget!({ id: 7, first_name: "Alice" });
    await first;
    expect(globalCopy.copyChatId).toBe(-1001);
  });

  test("/stop_copy 对空状态只提示，对活动状态清空全部复制字段", async () => {
    await handleStopCommand(context());
    expect(saveStateInBackground).not.toHaveBeenCalled();

    globalCopy.copiedUser = { id: 7, first_name: "Alice" };
    globalCopy.copyMode = "nya";
    globalCopy.copyChatId = -1001;
    await handleStopCommand(context());
    expect(globalCopy).toEqual({ copiedUser: null });
    expect(saveStateInBackground).toHaveBeenCalledWith("copy stopped");
  });

  test("/steal_icon 失败回滚冷却，成功只更新头像、不触碰复制状态", async () => {
    target = undefined;
    await handleStealIconCommand(context());
    expect(releaseCopyCooldownClaim).toHaveBeenCalledWith(claim);

    target = { id: 7, first_name: "Alice" };
    await handleStealIconCommand(context());
    expect(stealAvatarInBackground).toHaveBeenCalledTimes(1);
    expect(globalCopy).toEqual({ copiedUser: null });
  });
});
