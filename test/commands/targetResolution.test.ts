import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CachedUser } from "../../packages/types";

const sendMessageMock = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
let replyTarget: CachedUser | undefined;
const knownTargets = new Map<string, CachedUser>();
const knownIdTargets = new Map<number, CachedUser>();

mock.module("../../packages/infra/telegram", () => ({ sendMessage: sendMessageMock }));
mock.module("../../packages/users/senderIdentity", () => ({
  resolveReplyTarget: (): CachedUser | undefined => replyTarget,
  resolveUsernameTarget: (username: string): CachedUser | undefined => knownTargets.get(username.toLowerCase()),
  // 真实实现在缓存落空时也会给出只带 id 的最小身份——id 本身就是权威目标；
  // 负数 id 一律带上 isChannel（真实实现同此，见 users/senderIdentity.ts）。
  resolveIdTarget: (targetId: number): CachedUser =>
    knownIdTargets.get(targetId) ?? (targetId < 0 ? { id: targetId, isChannel: true } : { id: targetId }),
}));

const { resolveCommandTarget } = await import("../../packages/commands/targetResolution");
const {
  INVALID_USERNAME_ECHO_MAX_CHARS,
  TELEGRAM_USERNAME_MIN_LENGTH,
  TELEGRAM_USERNAME_MAX_LENGTH,
} = await import("../../packages/consts/commands");

const messages = {
  missingTarget: "missing",
  invalidUsername: (raw: string): string => `invalid:${raw}`,
  unknownUsername: (raw: string): string => `unknown:${raw}`,
  conflictingTarget: (raw: string): string => `conflict:${raw}`,
  selfTarget: "self",
};

function params(argument: string, acceptUserId: boolean = false, acceptChatId: boolean = false): any {
  return {
    chatId: -1001,
    message: { message_id: 7 },
    botUserId: 999,
    rawArgument: argument,
    messages,
    acceptUserId,
    acceptChatId,
  };
}

describe("resolveCommandTarget", () => {
  beforeEach(() => {
    replyTarget = undefined;
    knownTargets.clear();
    knownIdTargets.clear();
    sendMessageMock.mockClear();
  });

  test("只给回复目标时用它：对方没有公开 username、或本天才没缓存过 TA 时这是唯一的路", async () => {
    replyTarget = { id: 42, first_name: "Reply Target" };
    expect(await resolveCommandTarget(params(""))).toEqual(replyTarget);
    expect(await resolveCommandTarget(params("   "))).toEqual(replyTarget);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test("回归用例：回复目标与参数指向不同的人时报冲突，绝不静默取一", async () => {
    // 管理员看到群里有人贴出「请封 123456789」，对着那条消息点回复再发
    // /block 123456789：静默优先取回复目标，被永久拉黑并在每个托管群封禁的就是
    // 贴出这串 id 的同事，而回执显示的正是那位同事的名字。
    replyTarget = { id: 42, first_name: "Reply Target" };
    expect(await resolveCommandTarget(params("123456789", true))).toBeUndefined();
    expect(sendMessageMock).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: "conflict:123456789",
      replyToMessageId: 7,
    });

    // 参数解析不出目标时同样报冲突：说「这不是合法用户名」会让人以为参数被
    // 忽略、回复目标生效了。
    expect(await resolveCommandTarget(params(" @bad-name trailing"))).toBeUndefined();
    expect(sendMessageMock).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: "conflict:@bad-name trailing",
      replyToMessageId: 7,
    });
  });

  test("参数与回复指向同一个人是无害的重复，照常放行", async () => {
    replyTarget = { id: 42, first_name: "Reply Target" };
    expect(await resolveCommandTarget(params("42", true))).toEqual(replyTarget);

    knownTargets.set("alice_1", { id: 42, username: "Alice_1" });
    expect(await resolveCommandTarget(params("@Alice_1"))).toEqual(replyTarget);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test("有意保留当前群组 sender_chat，供 copy 类命令复制头像和复读皮套消息", async () => {
    replyTarget = { id: -1001, title: "Test Group", isChannel: true };

    expect(await resolveCommandTarget(params(""))).toEqual(replyTarget);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test("无回复且 trim 后为空时报告缺少目标", async () => {
    expect(await resolveCommandTarget(params("   "))).toBeUndefined();
    expect(sendMessageMock).toHaveBeenCalledWith({ chatId: -1001, text: "missing", replyToMessageId: 7 });
  });

  test("合法用户名允许可选 @ 和前后空白，并完整交给缓存解析", async () => {
    knownTargets.set("alice_1", { id: 42, username: "Alice_1" });
    expect(await resolveCommandTarget(params("  @Alice_1  "))).toEqual({ id: 42, username: "Alice_1" });
    expect(await resolveCommandTarget(params("Alice_1"))).toEqual({ id: 42, username: "Alice_1" });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test("非法字符、首字符、尾下划线和额外未消费内容均报告格式错误", async () => {
    for (const argument of ["@foo-bar", "@1alice", "@_alice", "@alice_", "@alice extra"]) {
      sendMessageMock.mockClear();
      expect(await resolveCommandTarget(params(argument))).toBeUndefined();
      expect(sendMessageMock).toHaveBeenCalledWith({ chatId: -1001, text: `invalid:${argument}`, replyToMessageId: 7 });
    }
  });

  test("回显的参数原文按上限截断并压成单行，出站文案不会撑爆单条消息上限", async () => {
    // 参数原文可以长到近 4096 字符（命令词之后的全部内容）。原样插回提示语拼出的
    // 就是一条超过 Telegram 单条上限的消息，发不出去、被吞进日志，用户收到的是
    // 彻底的沉默——而命令的限频名额早就扣掉了。
    const huge: string = "长".repeat(4_000);
    expect(await resolveCommandTarget(params(huge))).toBeUndefined();
    const sent = sendMessageMock.mock.calls.at(-1)![0] as { text: string };
    expect(sent.text).toBe(`invalid:${"长".repeat(INVALID_USERNAME_ECHO_MAX_CHARS)}`);

    // 多行参数压成单行后再截断，不把一整块贴图糊进嘲讽里。
    sendMessageMock.mockClear();
    expect(await resolveCommandTarget(params("@bad\n\n  name"))).toBeUndefined();
    expect(sendMessageMock).toHaveBeenLastCalledWith({ chatId: -1001, text: "invalid:@bad name", replyToMessageId: 7 });
  });

  test("用户名长度边界为 5~32，边界内合法、边界外拒绝", async () => {
    const atMin: string = `a${"b".repeat(TELEGRAM_USERNAME_MIN_LENGTH - 1)}`;
    const atMax: string = `a${"b".repeat(TELEGRAM_USERNAME_MAX_LENGTH - 1)}`;
    knownTargets.set(atMin, { id: 1, username: atMin });
    knownTargets.set(atMax, { id: 2, username: atMax });
    expect((await resolveCommandTarget(params(atMin)))?.id).toBe(1);
    expect((await resolveCommandTarget(params(atMax)))?.id).toBe(2);

    for (const argument of [atMin.slice(1), `${atMax}x`]) {
      expect(await resolveCommandTarget(params(argument))).toBeUndefined();
      expect(sendMessageMock).toHaveBeenLastCalledWith({ chatId: -1001, text: `invalid:${argument}`, replyToMessageId: 7 });
    }
  });

  test("合法但未缓存与目标为机器人自己仍使用各自错误", async () => {
    expect(await resolveCommandTarget(params("ghost"))).toBeUndefined();
    expect(sendMessageMock).toHaveBeenLastCalledWith({ chatId: -1001, text: "unknown:ghost", replyToMessageId: 7 });

    knownTargets.set("mybot", { id: 999, username: "mybot" });
    expect(await resolveCommandTarget(params("mybot"))).toBeUndefined();
    expect(sendMessageMock).toHaveBeenLastCalledWith({ chatId: -1001, text: "self", replyToMessageId: 7 });
  });

  test("裸用户 id 默认不认，避免 /copy 与动作命令拿到一具没名字的空壳", async () => {
    expect(await resolveCommandTarget(params("42"))).toBeUndefined();
    expect(sendMessageMock).toHaveBeenLastCalledWith({ chatId: -1001, text: "invalid:42", replyToMessageId: 7 });
  });

  test("开了 acceptUserId 后，裸 id 直接成立——不查缓存，也就没有「还没说过话」", async () => {
    expect(await resolveCommandTarget(params("42", true))).toEqual({ id: 42 });
    expect(sendMessageMock).not.toHaveBeenCalled();

    // 缓存里有这个人时沿用那份身份，回执才有名字可念。
    knownIdTargets.set(42, { id: 42, username: "alice_1" });
    expect(await resolveCommandTarget(params("  42  ", true))).toEqual({ id: 42, username: "alice_1" });
  });

  test("id 与用户名形态互斥，开了开关也不影响用户名那条路", async () => {
    knownTargets.set("alice_1", { id: 7, username: "alice_1" });
    expect(await resolveCommandTarget(params("@alice_1", true))).toEqual({ id: 7, username: "alice_1" });
    expect(await resolveCommandTarget(params("ghost", true))).toBeUndefined();
    expect(sendMessageMock).toHaveBeenLastCalledWith({ chatId: -1001, text: "unknown:ghost", replyToMessageId: 7 });
  });

  test("只开 acceptUserId 时负数、零、前导零、小数与超出安全整数的位数一律拒绝", async () => {
    // 负数 id 是会话身份，只有单独开了 acceptChatId 的 /unblock 才认——/block
    // 走到这里就该拒绝，粘错一个会话 id 会把处置改成封掉整个会话身份；
    // 20 位那种完全匹配「十进制正整数」，Number 之后却已经是另一个数了。
    for (const argument of ["-1001", "-1001234567890", "0", "007", "4.2", "1e5", "99999999999999999999"]) {
      sendMessageMock.mockClear();
      expect(await resolveCommandTarget(params(argument, true))).toBeUndefined();
      expect(sendMessageMock).toHaveBeenCalledWith({ chatId: -1001, text: `invalid:${argument}`, replyToMessageId: 7 });
    }
  });

  test("开了 acceptChatId 后负数 id 成立，并带上决定解封接口的 isChannel", async () => {
    // 这个标记是承重的：/unblock ... all 靠它选 unbanChatSenderChat，漏标就会拿
    // 负数去调 unbanChatMemberIfBanned，报错记进 failedCount 变成假战报。
    expect(await resolveCommandTarget(params("-1002233445566", true, true)))
      .toEqual({ id: -1002233445566, isChannel: true });
    expect(sendMessageMock).not.toHaveBeenCalled();

    // 缓存里见过这个频道时沿用那份身份，回执才念得出频道名。
    knownIdTargets.set(-1002233445566, { id: -1002233445566, title: "Ad Channel", isChannel: true });
    expect(await resolveCommandTarget(params("  -1002233445566  ", true, true)))
      .toEqual({ id: -1002233445566, title: "Ad Channel", isChannel: true });
  });

  test("开了 acceptChatId 也只放行负号那一种形态，畸形写法照样拒绝", async () => {
    // -0 与 -007 会被 Number 归成 0 / -7，那都不是任何一个会话；位数超出安全整数
    // 的负数同样在 Number 之后改指别处，理由与正数那条完全对称。
    for (const argument of ["-0", "-007", "-4.2", "-1e5", "-99999999999999999999", "- 1001"]) {
      sendMessageMock.mockClear();
      expect(await resolveCommandTarget(params(argument, true, true))).toBeUndefined();
      expect(sendMessageMock).toHaveBeenCalledWith({ chatId: -1001, text: `invalid:${argument}`, replyToMessageId: 7 });
    }
  });

  test("单开 acceptChatId 时正整数不放行：两条路各管各的开关", async () => {
    expect(await resolveCommandTarget(params("42", false, true))).toBeUndefined();
    expect(sendMessageMock).toHaveBeenLastCalledWith({ chatId: -1001, text: "invalid:42", replyToMessageId: 7 });
  });

  test("id 参数解析出的目标是机器人自己时照样被拒", async () => {
    expect(await resolveCommandTarget(params("999", true))).toBeUndefined();
    expect(sendMessageMock).toHaveBeenLastCalledWith({ chatId: -1001, text: "self", replyToMessageId: 7 });
  });
});
