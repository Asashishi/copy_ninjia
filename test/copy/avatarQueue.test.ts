import { beforeEach, describe, expect, mock, test } from "bun:test";

/** 头像执行槽的回执开关：silent 任务只换头像、不发回执。 */

const restoreDefaultProfilePhoto = mock(async (..._args: unknown[]): Promise<boolean> => true);
const sendCommandMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
mock.module("../../packages/infra/telegram/avatar/restore", () => ({ restoreDefaultProfilePhoto }));
mock.module("../../packages/infra/telegram/avatar/copy", () => ({
  copyUserProfilePhoto: async (): Promise<boolean> => true,
}));
mock.module("../../packages/infra/telegram", () => ({ sendCommandMessage }));
mock.module("../../packages/config/assets", () => ({
  getAssetConfig: (): Readonly<{ botDefaultAvatar: string }> => ({ botDefaultAvatar: "avatar.png" }),
}));

const { drainAvatarUpdates, initAvatarUpdates, queueAvatarUpdate } = await import("../../packages/copy/avatarQueue");

beforeEach(() => {
  restoreDefaultProfilePhoto.mockClear();
  sendCommandMessage.mockClear();
  initAvatarUpdates();
});

describe("头像更新回执", () => {
  test("silent 复原照常换头像但不发回执", async () => {
    queueAvatarUpdate({ chatId: -1001, target: { kind: "default" }, source: "copy", silent: true });
    await expect(drainAvatarUpdates(1_000)).resolves.toBe("flushed");

    expect(restoreDefaultProfilePhoto).toHaveBeenCalledTimes(1);
    expect(sendCommandMessage).not.toHaveBeenCalled();
  });

  test("缺省不是 silent，复原后在提交群发一条回执", async () => {
    queueAvatarUpdate({ chatId: -1001, target: { kind: "default" }, source: "copy" });
    await expect(drainAvatarUpdates(1_000)).resolves.toBe("flushed");

    expect(restoreDefaultProfilePhoto).toHaveBeenCalledTimes(1);
    expect(sendCommandMessage).toHaveBeenCalledTimes(1);
    expect(sendCommandMessage.mock.calls[0]?.[0]).toMatchObject({ chatId: -1001 });
  });
});
