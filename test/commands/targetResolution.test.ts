import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CachedUser } from "../../packages/types";

const sendMessageMock = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
let replyTarget: CachedUser | undefined;
const knownTargets = new Map<string, CachedUser>();

mock.module("../../packages/infra/telegram", () => ({ sendMessage: sendMessageMock }));
mock.module("../../packages/users/senderIdentity", () => ({
  resolveReplyTarget: (): CachedUser | undefined => replyTarget,
  resolveUsernameTarget: (username: string): CachedUser | undefined => knownTargets.get(username.toLowerCase()),
}));

const { resolveCommandTarget } = await import("../../packages/commands/targetResolution");
const { TELEGRAM_USERNAME_MIN_LENGTH, TELEGRAM_USERNAME_MAX_LENGTH } = await import("../../packages/consts/commands");

const messages = {
  missingTarget: "missing",
  invalidUsername: (raw: string): string => `invalid:${raw}`,
  unknownUsername: (raw: string): string => `unknown:${raw}`,
  selfTarget: "self",
};

function context(argument: string): any {
  return {
    chat: { id: -1001 },
    msgId: 7,
    match: argument,
    msg: { message_id: 7 },
    me: { id: 999 },
  };
}

describe("resolveCommandTarget", () => {
  beforeEach(() => {
    replyTarget = undefined;
    knownTargets.clear();
    sendMessageMock.mockClear();
  });

  test("回复目标始终优先，空参数或非法附带参数都不影响", async () => {
    replyTarget = { id: 42, first_name: "Reply Target" };
    expect(await resolveCommandTarget(context(""), messages)).toEqual(replyTarget);
    expect(await resolveCommandTarget(context(" @bad-name trailing"), messages)).toEqual(replyTarget);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test("有意保留当前群组 sender_chat，供 copy 类命令复制头像和复读皮套消息", async () => {
    replyTarget = { id: -1001, title: "Test Group", isChannel: true };

    expect(await resolveCommandTarget(context(""), messages)).toEqual(replyTarget);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test("无回复且 trim 后为空时报告缺少目标", async () => {
    expect(await resolveCommandTarget(context("   "), messages)).toBeUndefined();
    expect(sendMessageMock).toHaveBeenCalledWith({ chatId: -1001, text: "missing", replyToMessageId: 7 });
  });

  test("合法用户名允许可选 @ 和前后空白，并完整交给缓存解析", async () => {
    knownTargets.set("alice_1", { id: 42, username: "Alice_1" });
    expect(await resolveCommandTarget(context("  @Alice_1  "), messages)).toEqual({ id: 42, username: "Alice_1" });
    expect(await resolveCommandTarget(context("Alice_1"), messages)).toEqual({ id: 42, username: "Alice_1" });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test("非法字符、首字符、尾下划线和额外未消费内容均报告格式错误", async () => {
    for (const argument of ["@foo-bar", "@1alice", "@_alice", "@alice_", "@alice extra"]) {
      sendMessageMock.mockClear();
      expect(await resolveCommandTarget(context(argument), messages)).toBeUndefined();
      expect(sendMessageMock).toHaveBeenCalledWith({ chatId: -1001, text: `invalid:${argument}`, replyToMessageId: 7 });
    }
  });

  test("用户名长度边界为 5~32，边界内合法、边界外拒绝", async () => {
    const atMin: string = `a${"b".repeat(TELEGRAM_USERNAME_MIN_LENGTH - 1)}`;
    const atMax: string = `a${"b".repeat(TELEGRAM_USERNAME_MAX_LENGTH - 1)}`;
    knownTargets.set(atMin, { id: 1, username: atMin });
    knownTargets.set(atMax, { id: 2, username: atMax });
    expect((await resolveCommandTarget(context(atMin), messages))?.id).toBe(1);
    expect((await resolveCommandTarget(context(atMax), messages))?.id).toBe(2);

    for (const argument of [atMin.slice(1), `${atMax}x`]) {
      expect(await resolveCommandTarget(context(argument), messages)).toBeUndefined();
      expect(sendMessageMock).toHaveBeenLastCalledWith({ chatId: -1001, text: `invalid:${argument}`, replyToMessageId: 7 });
    }
  });

  test("合法但未缓存与目标为机器人自己仍使用各自错误", async () => {
    expect(await resolveCommandTarget(context("ghost"), messages)).toBeUndefined();
    expect(sendMessageMock).toHaveBeenLastCalledWith({ chatId: -1001, text: "unknown:ghost", replyToMessageId: 7 });

    knownTargets.set("mybot", { id: 999, username: "mybot" });
    expect(await resolveCommandTarget(context("mybot"), messages)).toBeUndefined();
    expect(sendMessageMock).toHaveBeenLastCalledWith({ chatId: -1001, text: "self", replyToMessageId: 7 });
  });
});
