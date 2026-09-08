import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../helpers/loggerMock";
import type { CachedUser, CopyMode } from "../../packages/types/chatState";
import {
  COPY_TARGET_TEXTS,
  NYA_COPY_TARGET_TEXTS,
  REVERSE_COPY_TARGET_TEXTS,
} from "../../packages/consts/commands";
import { COPY_USAGE_TEXT, ICON_USAGE_TEXT } from "../../packages/consts/commandUsage";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const saveStateInBackground = mock((..._args: unknown[]): void => {});
const releaseCopyCooldownClaim = mock((..._args: unknown[]): void => {});
const stealAvatarInBackground = mock((..._args: unknown[]): void => {});
const restoreAvatarInBackground = mock((..._args: unknown[]): void => {});
let cooldownRejected: boolean = false;
let target: CachedUser | undefined;
const claim = { rejected: false as const, previousLastCopyTime: undefined, claimedAt: 123 };
const globalCopy: {
  copiedUser: CachedUser | null;
  copyMode?: string;
  copyChatId?: number;
} = { copiedUser: null };
let jaReadiness: { ok: true } | { ok: false; failure: { file: string; reason: string } } = { ok: true };

const claimCopyCooldownOrReject = mock(async () => cooldownRejected ? { rejected: true as const } : claim);
const resolveCopyCommandTarget = mock(async (..._args: unknown[]): Promise<CachedUser | undefined> => target);

const loggerError = mock((..._args: unknown[]): void => {});
mock.module("../../packages/infra/logger", () => ({ logger: loggerStub({ error: loggerError }) }));
mock.module("../../packages/config/readiness", () => ({
  translateConfigReadiness: () => jaReadiness,
}));
mock.module("../../packages/infra/telegram", () => ({
  sendCommandMessage: sendMessage,
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getGlobalCopyState: () => globalCopy,
  persistGlobalState: async (context: string): Promise<void> => { saveStateInBackground(context); },
}));
mock.module("../../packages/commands/copyShared", () => ({
  claimCopyCooldownOrReject,
  releaseCopyCooldownClaim,
  resolveCopyCommandTarget,
  stealAvatarInBackground,
  restoreAvatarInBackground,
}));

const { handleCopyCommand } = await import("../../packages/commands/copy");
const { handleIconCommand } = await import("../../packages/commands/icon");

function context(chatId: number = -1001, replyToUserId?: number, argument: string = ""): never {
  return {
    chat: { id: chatId },
    from: { id: 8, first_name: "Caller" },
    msgId: 9,
    // 活动 copy 拒绝分支用 peekCommandTarget 只读地看一眼目标（回复优先），
    // 因此这里必须是一条真实形状的消息。
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
    match: argument,
  } as never;
}

beforeEach(() => {
  cooldownRejected = false;
  target = { id: 7, first_name: "Alice", username: "alice" };
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
    restoreAvatarInBackground,
    claimCopyCooldownOrReject,
    resolveCopyCommandTarget,
  ]) mocked.mockClear();
});

describe("copy 类命令生命周期", () => {
  test.each([
    ["", undefined, ""],
    ["@alice", undefined, "@alice"],
    ["reverse", "reverse", ""],
    ["  reverse\t@alice  ", "reverse", "@alice"],
    ["nya", "nya", ""],
    ["nya\n@alice", "nya", "@alice"],
    ["@reverse", undefined, "@reverse"],
    ["reverse_alice", undefined, "reverse_alice"],
  ] as const)("/copy 参数 %s 分派模式并保留目标", async (argument, mode, targetArgument) => {
    const ctx = context(-1001, 7, argument);
    await handleCopyCommand(ctx);
    expect(globalCopy.copyMode).toBe(mode);
    expect(resolveCopyCommandTarget.mock.calls[0]?.[2]).toBe(targetArgument);
    expect(stealAvatarInBackground).toHaveBeenCalledTimes(1);
  });

  test.each(["stop @alice", "stop reverse", "stop\nnya"])("/copy %s 不停止会话也不占冷却", async (argument) => {
    globalCopy.copiedUser = { id: 7, first_name: "Alice" };
    globalCopy.copyMode = "nya";
    globalCopy.copyChatId = -1001;
    await handleCopyCommand(context(-1001, undefined, argument));
    expect(globalCopy.copyMode).toBe("nya");
    expect(globalCopy.copiedUser?.id).toBe(7);
    expect(saveStateInBackground).not.toHaveBeenCalled();
    expect(claimCopyCooldownOrReject).not.toHaveBeenCalled();
    expect(restoreAvatarInBackground).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({ chatId: -1001, text: COPY_USAGE_TEXT, replyToMessageId: 9 });
  });

  test("全局冷却拒绝时不解析目标", async () => {
    cooldownRejected = true;
    await handleCopyCommand(context());
    expect(resolveCopyCommandTarget).not.toHaveBeenCalled();
  });

  test("密钥可用时其余 copy 模式不受这道判定影响", async () => {
    jaReadiness = { ok: false, failure: { file: "g-auth.json", reason: "Invalid g-auth.json: boom" } };
    await handleCopyCommand(context(-1001, undefined, "nya"));

    expect(claimCopyCooldownOrReject).toHaveBeenCalledTimes(1);
  });

  test("各 copy 模式把写有实际命令名的目标提示交给解析器", async () => {
    target = undefined;
    for (const [mode, texts] of [
      [undefined, COPY_TARGET_TEXTS],
      ["reverse", REVERSE_COPY_TARGET_TEXTS],
      ["nya", NYA_COPY_TARGET_TEXTS],
    ] as const satisfies readonly (readonly [CopyMode | undefined, typeof COPY_TARGET_TEXTS])[]) {
      resolveCopyCommandTarget.mockClear();
      await handleCopyCommand(context(-1001, undefined, mode ?? ""));
      expect(resolveCopyCommandTarget.mock.calls[0]?.[1]).toBe(texts);
    }
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
      text: expect.stringContaining("先 /copy stop"),
      replyToMessageId: 9,
    });
  });

  test("已有复制目标时只回一条拒绝，不触发带发送副作用的目标解析", async () => {
    // 走完整解析的话，参数是未缓存的 @username 时它会自己发一条「@x 都还没
    // 说过话呢」然后返回 undefined——用户收到的是「不认识这个用户名」，而真正
    // 的原因（正在复读别人）永远没说出口。
    globalCopy.copiedUser = { id: 7, first_name: "Alice" };

    await handleCopyCommand(context());

    expect(resolveCopyCommandTarget).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("先 /copy stop"),
      replyToMessageId: 9,
    });
  });

  test("成功启动立即写全局状态，头像更新留在受控后台任务", async () => {
    await handleCopyCommand(context(-1001, undefined, "reverse"));

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

  test("/copy stop 对空状态只提示，对活动状态清空全部复制字段", async () => {
    await handleCopyCommand(context(-1001, undefined, "stop"));
    expect(saveStateInBackground).not.toHaveBeenCalled();
    // 什么都没在复读时不该动脸：没偷过就没什么可复原的。
    expect(restoreAvatarInBackground).not.toHaveBeenCalled();

    globalCopy.copiedUser = { id: 7, first_name: "Alice" };
    globalCopy.copyMode = "nya";
    globalCopy.copyChatId = -1001;
    await handleCopyCommand(context(-1001, undefined, "stop"));
    expect(globalCopy).toEqual({ copiedUser: null });
    expect(saveStateInBackground).toHaveBeenCalledWith("copy stopped");
  });

  test("/copy stop 停掉复读后顺带把头像复原", async () => {
    // /copy 会偷目标头像，只停复读不复原会留下「已经不复读了、却还顶着别人脸」。
    globalCopy.copiedUser = { id: 7, first_name: "Alice" };
    globalCopy.copyChatId = -1001;
    await handleCopyCommand(context(-1001, undefined, "stop"));
    expect(restoreAvatarInBackground).toHaveBeenCalledTimes(1);
  });

  test("/copy stop 的复原不占全局冷却：被冷却挡住就成了「停不掉」", async () => {
    cooldownRejected = true;
    globalCopy.copiedUser = { id: 7, first_name: "Alice" };
    globalCopy.copyChatId = -1001;
    await handleCopyCommand(context(-1002, undefined, "  stop\n"));
    expect(globalCopy).toEqual({ copiedUser: null });
    expect(restoreAvatarInBackground).toHaveBeenCalledTimes(1);
    expect(claimCopyCooldownOrReject).not.toHaveBeenCalled();
    cooldownRejected = false;
  });

  test("/icon steal 失败回滚冷却，成功只更新头像、不触碰复制状态", async () => {
    target = undefined;
    await handleIconCommand(context(-1001, undefined, "steal"));
    expect(releaseCopyCooldownClaim).toHaveBeenCalledWith(claim);

    target = { id: 7, first_name: "Alice" };
    await handleIconCommand(context(-1001, undefined, "steal"));
    expect(stealAvatarInBackground).toHaveBeenCalledTimes(1);
    expect(globalCopy).toEqual({ copiedUser: null });
  });

  test.each(["steal", "steal @alice", "  steal\t@alice  "])("/icon %s 只把目标参数交给解析器", async (argument) => {
    await handleIconCommand(context(-1001, 7, argument));
    expect(resolveCopyCommandTarget.mock.calls[0]?.[2]).toBe(argument.includes("@alice") ? "@alice" : "");
    expect(stealAvatarInBackground).toHaveBeenCalledTimes(1);
    expect(globalCopy.copiedUser).toBeNull();
  });

  test.each(["", "unknown", "reset @alice", "reset steal", "stealer"])("/icon %s 只提示用法，不占冷却或换头像", async (argument) => {
    await handleIconCommand(context(-1001, undefined, argument));
    expect(claimCopyCooldownOrReject).not.toHaveBeenCalled();
    expect(resolveCopyCommandTarget).not.toHaveBeenCalled();
    expect(stealAvatarInBackground).not.toHaveBeenCalled();
    expect(restoreAvatarInBackground).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({ chatId: -1001, text: ICON_USAGE_TEXT, replyToMessageId: 9 });
  });

  test("/icon reset 复原头像、占用全局冷却，且不触碰复读状态", async () => {
    globalCopy.copiedUser = { id: 7, first_name: "Alice" };
    globalCopy.copyChatId = -1001;

    await handleIconCommand(context(-1001, undefined, "reset"));

    expect(claimCopyCooldownOrReject).toHaveBeenCalledTimes(1);
    expect(restoreAvatarInBackground).toHaveBeenCalledTimes(1);
    // 与 /icon steal 对称：这条命令只管脸，正在复读谁保持原样。
    expect(globalCopy.copiedUser).toEqual({ id: 7, first_name: "Alice" });
    expect(saveStateInBackground).not.toHaveBeenCalled();
  });

  test("/icon reset 被冷却挡住时不换脸：它和 /icon steal 抢同一份限流资源", async () => {
    cooldownRejected = true;
    await handleIconCommand(context(-1001, undefined, "reset"));
    expect(restoreAvatarInBackground).not.toHaveBeenCalled();
    cooldownRejected = false;
  });
});
