import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { CachedUser } from "../../src/types/chatState";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const copyUserProfilePhoto = mock(async (..._args: unknown[]): Promise<boolean> => true);
const saveStateInBackground = mock((..._args: unknown[]): void => {});
const resolveCommandTarget = mock(async (..._args: unknown[]): Promise<CachedUser | undefined> => ({ id: 7, first_name: "Alice" }));
const loggerError = mock((..._args: unknown[]): void => {});
const globalCopyState: { lastCopyTime?: number } = {};

mock.module("../../src/infra/config", () => ({ PRIVILEGED_USERS_ID: [100] }));
mock.module("../../src/infra/telegram", () => ({ sendMessage, copyUserProfilePhoto }));
mock.module("../../src/infra/storage/stateStore", () => ({
  getGlobalCopyState: () => globalCopyState,
  saveStateInBackground,
}));
mock.module("../../src/commands/targetResolution", () => ({ resolveCommandTarget }));
mock.module("../../src/infra/logger", () => ({
  logger: {
    log: mock((..._args: unknown[]): void => {}),
    info: mock((..._args: unknown[]): void => {}),
    warn: mock((..._args: unknown[]): void => {}),
    error: loggerError,
  },
}));

const shared = await import("../../src/commands/copyShared");
const { COPY_COOLDOWN_MS } = await import("../../src/consts/commands");
const originalDateNow: () => number = Date.now;

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt: number = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for background avatar task");
}

beforeEach(() => {
  delete globalCopyState.lastCopyTime;
  Date.now = (): number => 1_000_000;
  for (const mocked of [
    sendMessage,
    copyUserProfilePhoto,
    saveStateInBackground,
    resolveCommandTarget,
    loggerError,
  ]) mocked.mockClear();
  copyUserProfilePhoto.mockImplementation(async (): Promise<boolean> => true);
  resolveCommandTarget.mockImplementation(async (): Promise<CachedUser | undefined> => ({ id: 7, first_name: "Alice" }));
});

afterEach(() => {
  Date.now = originalDateNow;
});

describe("copy 命令共享冷却与头像串行器", () => {
  test("普通用户原子占用全局冷却，窗口内下一次调用被拒绝", async () => {
    const claim = await shared.claimCopyCooldownOrReject({ id: 8 }, -1001, 10);
    expect(claim).toEqual({ rejected: false, previousLastCopyTime: undefined, claimedAt: 1_000_000 });
    expect(globalCopyState.lastCopyTime).toBe(1_000_000);
    expect(saveStateInBackground).toHaveBeenCalledWith("copy cooldown claimed");

    Date.now = (): number => 1_000_000 + COPY_COOLDOWN_MS - 1;
    await expect(shared.claimCopyCooldownOrReject({ id: 9 }, -1002, 11)).resolves.toEqual({ rejected: true });
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: -1002,
      text: expect.stringContaining("还要等"),
      replyToMessageId: 11,
    });
    expect(globalCopyState.lastCopyTime).toBe(1_000_000);
  });

  test("白名单绕过检查但仍刷新占用；回滚只删除自己仍持有的占位", async () => {
    globalCopyState.lastCopyTime = 900_000;
    const claim = await shared.claimCopyCooldownOrReject({ id: 100 }, -1001, 10);
    expect(claim).toEqual({ rejected: false, previousLastCopyTime: 900_000, claimedAt: 1_000_000 });

    globalCopyState.lastCopyTime = 1_000_001;
    shared.releaseCopyCooldownClaim(claim as Exclude<typeof claim, { rejected: true }>);
    expect(globalCopyState.lastCopyTime).toBe(1_000_001);

    globalCopyState.lastCopyTime = 1_000_000;
    shared.releaseCopyCooldownClaim(claim as Exclude<typeof claim, { rejected: true }>);
    expect(globalCopyState.lastCopyTime).toBe(900_000);
    expect(saveStateInBackground).toHaveBeenLastCalledWith("copy cooldown released");
  });

  test("目标解析器收到 copy 专用错误文案", async () => {
    const ctx = { chat: { id: -1001 }, match: "@alice" } as never;
    await expect(shared.resolveCopyCommandTarget(ctx, "/steal_icon")).resolves.toEqual({ id: 7, first_name: "Alice" });
    const options = resolveCommandTarget.mock.calls[0]![1] as { missingTarget: string; selfTarget: string };
    expect(options.missingTarget).toContain("/steal_icon");
    expect(options.selfTarget).toContain("自己");
  });

  test("头像任务严格串行，并按布尔结果发送成功或失败战报", async () => {
    let resolveFirst!: (value: boolean) => void;
    copyUserProfilePhoto
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(false);
    const firstTarget: CachedUser = { id: 7, first_name: "Alice", username: "alice" };
    const secondTarget: CachedUser = { id: -2002, first_name: "Channel", username: "channel", isChannel: true };

    shared.stealAvatarInBackground({
      chatId: -1001,
      target: firstTarget,
      successText: "first-ok",
      failureText: "first-fail",
    });
    shared.stealAvatarInBackground({
      chatId: -1002,
      target: secondTarget,
      successText: "second-ok",
      failureText: "second-fail",
    });
    await waitFor(() => copyUserProfilePhoto.mock.calls.length === 1);
    expect(copyUserProfilePhoto).toHaveBeenCalledWith(7, false, "alice");

    resolveFirst(true);
    await waitFor(() => sendMessage.mock.calls.length === 2);
    expect(copyUserProfilePhoto).toHaveBeenNthCalledWith(2, -2002, true, "channel");
    expect(sendMessage.mock.calls).toEqual([
      [{ chatId: -1001, text: "first-ok" }],
      [{ chatId: -1002, text: "second-fail" }],
    ]);
  });

  test("头像任务抛错由串行器记录，后续任务仍可继续", async () => {
    copyUserProfilePhoto.mockRejectedValueOnce(new Error("avatar failed"));
    shared.stealAvatarInBackground({
      chatId: -1001,
      target: { id: 7, first_name: "Alice" },
      successText: "ok",
      failureText: "fail",
    });
    await waitFor(() => loggerError.mock.calls.length === 1);
    expect(loggerError).toHaveBeenCalledWith("Error in background avatar steal task:", expect.any(Error));
  });
});
