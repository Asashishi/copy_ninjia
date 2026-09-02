import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { CachedUser } from "../../packages/types/chatState";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const copyUserProfilePhoto = mock(async (..._args: unknown[]): Promise<boolean> => true);
const restoreDefaultProfilePhoto = mock(async (..._args: unknown[]): Promise<boolean> => true);
const saveStateInBackground = mock((..._args: unknown[]): void => {});
const resolveCommandTarget = mock(async (..._args: unknown[]): Promise<CachedUser | undefined> => ({ id: 7, first_name: "Alice" }));
const loggerError = mock((..._args: unknown[]): void => {});
const globalCopyState: { lastCopyTime?: number } = {};
const DEFAULT_AVATAR_URL: string = "https://cdn.example/default-face.jpg";

mock.module("../../packages/config/telegram", () => ({ SUPER_ADMIN_USER_ID: 100 }));
mock.module("../../packages/infra/telegram", () => ({
  sendCommandMessage: sendMessage,
}));
mock.module("../../packages/infra/telegram/avatar/copy", () => ({ copyUserProfilePhoto }));
mock.module("../../packages/infra/telegram/avatar/restore", () => ({ restoreDefaultProfilePhoto }));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getGlobalCopyState: () => globalCopyState,
  // copy/avatarQueue.ts 在主线程取默认头像直链后传给 restoreDefaultProfilePhoto；
  // 这里的替身必须一并提供，否则整个模块的具名导入会在加载期就失败。
  getBotDefaultAvatarUrl: (): string => DEFAULT_AVATAR_URL,
  persistGlobalState: async (context: string): Promise<void> => { saveStateInBackground(context); },
}));
mock.module("../../packages/commands/targetResolution", () => ({ resolveCommandTarget }));
mock.module("../../packages/infra/logger", () => ({
  logger: {
    log: mock((..._args: unknown[]): void => {}),
    info: mock((..._args: unknown[]): void => {}),
    warn: mock((..._args: unknown[]): void => {}),
    error: loggerError,
  },
}));

const shared = await import("../../packages/commands/copyShared");
const {
  drainAvatarUpdates,
  initAvatarUpdates,
  quiesceAvatarUpdates,
} = await import("../../packages/copy/avatarQueue");
const { avatarUpdateState } = await import("../../packages/cache/main/copy/avatar");
const { COPY_COOLDOWN_MS, STEAL_ICON_TARGET_TEXTS } =
  await import("../../packages/consts/commands");
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
    restoreDefaultProfilePhoto,
    saveStateInBackground,
    resolveCommandTarget,
    loggerError,
  ]) mocked.mockClear();
  copyUserProfilePhoto.mockImplementation(async (): Promise<boolean> => true);
  restoreDefaultProfilePhoto.mockImplementation(async (): Promise<boolean> => true);
  resolveCommandTarget.mockImplementation(async (): Promise<CachedUser | undefined> => ({ id: 7, first_name: "Alice" }));
  avatarUpdateState.pending = null;
  avatarUpdateState.running = false;
  avatarUpdateState.nextGeneration = 1;
  avatarUpdateState.latestGeneration = 0;
  initAvatarUpdates();
});

afterEach(() => {
  Date.now = originalDateNow;
});

describe("copy 命令共享冷却与头像串行器", () => {
  test("头像 drain 拒绝非有限与负预算", () => {
    expect(() => drainAvatarUpdates(-1)).toThrow("non-negative finite");
    expect(() => drainAvatarUpdates(Number.NaN)).toThrow("non-negative finite");
    expect(() => drainAvatarUpdates(Number.POSITIVE_INFINITY)).toThrow("non-negative finite");
  });

  test("零预算在空闲时直接结算为 flushed", async () => {
    await expect(drainAvatarUpdates(0)).resolves.toBe("flushed");
  });

  test("零预算在有任务在途时立即 abort 并结算为 timedOut", async () => {
    copyUserProfilePhoto.mockImplementationOnce(async (...args: unknown[]): Promise<boolean> => await new Promise<boolean>((_resolve, reject) => {
      const signal = (args[2] as { signal?: AbortSignal } | undefined)?.signal;
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    shared.stealAvatarInBackground({
      chatId: -1001,
      target: { id: 7, first_name: "Alice" },
      successText: "late-ok",
      failureText: "late-fail",
    });
    await waitFor(() => copyUserProfilePhoto.mock.calls.length === 1);

    quiesceAvatarUpdates();
    await expect(drainAvatarUpdates(0)).resolves.toBe("timedOut");
    await waitFor(() => !avatarUpdateState.running);

    // abort 后不得再发送迟到战报，与 docs/cn/04-invariants.md 的停机不变量一致。
    expect(sendMessage).not.toHaveBeenCalled();
    expect(avatarUpdateState.pending).toBeNull();
  });

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

  test("超级管理员绕过检查但仍刷新占用；回滚只删除自己仍持有的占位", async () => {
    globalCopyState.lastCopyTime = 900_000;
    const claim = await shared.claimCopyCooldownOrReject({ id: 100 }, -1001, 10);
    expect(claim).toEqual({ rejected: false, previousLastCopyTime: 900_000, claimedAt: 1_000_000 });

    globalCopyState.lastCopyTime = 1_000_001;
    await shared.releaseCopyCooldownClaim(claim as Exclude<typeof claim, { rejected: true }>);
    expect(globalCopyState.lastCopyTime).toBe(1_000_001);

    globalCopyState.lastCopyTime = 1_000_000;
    await shared.releaseCopyCooldownClaim(claim as Exclude<typeof claim, { rejected: true }>);
    expect(globalCopyState.lastCopyTime).toBe(900_000);
    expect(saveStateInBackground).toHaveBeenLastCalledWith("copy cooldown released");
  });

  test("墙钟回拨时旧冷却视为过期，并从当前时刻重新占用", async () => {
    globalCopyState.lastCopyTime = 1_100_000;

    const claim = await shared.claimCopyCooldownOrReject({ id: 8 }, -1001, 10);

    expect(claim).toEqual({ rejected: false, previousLastCopyTime: 1_100_000, claimedAt: 1_000_000 });
    expect(globalCopyState.lastCopyTime).toBe(1_000_000);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("目标解析器原样转交调用方给的文案表，不再每次现造", async () => {
    const ctx = { chat: { id: -1001 }, msg: { message_id: 9 }, me: { id: 999 }, match: "@alice" } as never;
    await expect(
      shared.resolveCopyCommandTarget(ctx, STEAL_ICON_TARGET_TEXTS)
    ).resolves.toEqual({ id: 7, first_name: "Alice" });
    const params = resolveCommandTarget.mock.calls[0]![0] as {
      rawArgument: string;
      messages: { missingTarget: string; selfTarget: string };
    };
    expect(params.rawArgument).toBe("@alice");
    expect(params.messages.missingTarget).toContain("/steal_icon");
    expect(params.messages.selfTarget).toContain("自己");
    // 转交的必须就是那张模块级单例，不是每次调用现造的副本。
    expect(params.messages).toBe(STEAL_ICON_TARGET_TEXTS);
  });

  test("头像全局并发度为 1，运行中只保留最新待执行目标与最新战报", async () => {
    let resolveFirst!: (value: boolean) => void;
    copyUserProfilePhoto
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(false);
    const firstTarget: CachedUser = { id: 7, first_name: "Alice", username: "alice" };
    const secondTarget: CachedUser = { id: -2002, first_name: "Old Channel", username: "old_channel", isChannel: true };
    const latestTarget: CachedUser = { id: -3003, first_name: "Latest Channel", username: "latest_channel", isChannel: true };

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
    shared.stealAvatarInBackground({
      chatId: -1003,
      target: latestTarget,
      successText: "latest-ok",
      failureText: "latest-fail",
    });
    await waitFor(() => copyUserProfilePhoto.mock.calls.length === 1);
    expect(copyUserProfilePhoto).toHaveBeenCalledWith(7, false, {
      username: "alice",
      signal: expect.any(AbortSignal),
    });

    resolveFirst(true);
    await waitFor(() => sendMessage.mock.calls.length === 1);
    expect(copyUserProfilePhoto).toHaveBeenCalledTimes(2);
    expect(copyUserProfilePhoto).toHaveBeenNthCalledWith(
      2,
      -3003,
      true,
      { username: "latest_channel", signal: expect.any(AbortSignal) }
    );
    expect(sendMessage.mock.calls).toEqual([
      [{ chatId: -1003, text: "latest-fail", signal: expect.any(AbortSignal) }],
    ]);
    await expect(drainAvatarUpdates(100)).resolves.toBe("flushed");
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
    expect(loggerError).toHaveBeenCalledWith("Error in background avatar update task:", expect.any(Error));
  });

  test("停机预算耗尽会 abort 悬挂头像任务且不发送迟到战报", async () => {
    copyUserProfilePhoto.mockImplementationOnce(async (...args: unknown[]): Promise<boolean> => await new Promise<boolean>((_resolve, reject) => {
      const signal = (args[2] as { signal?: AbortSignal } | undefined)?.signal;
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    shared.stealAvatarInBackground({
      chatId: -1001,
      target: { id: 7, first_name: "Alice" },
      successText: "late-ok",
      failureText: "late-fail",
    });
    await waitFor(() => copyUserProfilePhoto.mock.calls.length === 1);

    quiesceAvatarUpdates();
    await expect(drainAvatarUpdates(1)).resolves.toBe("timedOut");
    await waitFor(() => !avatarUpdateState.running);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(avatarUpdateState.pending).toBeNull();
  });

  test("复原任务与偷脸任务共用同一个执行槽，走 restoreDefaultProfilePhoto", async () => {
    shared.restoreAvatarInBackground({
      chatId: -1001,
      successText: "restored",
      failureText: "restore-failed",
    });
    await waitFor(() => restoreDefaultProfilePhoto.mock.calls.length === 1);
    await waitFor(() => !avatarUpdateState.running);

    // 复原不该走偷脸那条路径：两者的失败含义完全不同。
    expect(copyUserProfilePhoto).not.toHaveBeenCalled();
    // 直链在主线程取好后传进去，avatar/restore.ts 自己不碰 state（见 avatarQueue.ts）。
    expect(restoreDefaultProfilePhoto.mock.calls[0]?.[0]).toBe(DEFAULT_AVATAR_URL);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "restored" }));
  });

  test("复原失败时发失败战报", async () => {
    restoreDefaultProfilePhoto.mockImplementationOnce(async (): Promise<boolean> => false);
    shared.restoreAvatarInBackground({
      chatId: -1001,
      successText: "restored",
      failureText: "restore-failed",
    });
    await waitFor(() => restoreDefaultProfilePhoto.mock.calls.length === 1);
    await waitFor(() => !avatarUpdateState.running);

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "restore-failed" }));
  });
});
