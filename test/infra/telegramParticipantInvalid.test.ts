import { beforeEach, describe, expect, mock, test } from "bun:test";
import { GrammyError } from "grammy";
import type { Api } from "grammy";

/**
 * Telegram 以 400 PARTICIPANT_ID_INVALID 拒绝用户 ID 时的动作归一化：封禁与
 * 成员探测保留这一档并照常记 API 错误，/wed 复核读取把它当作离群且不记错误。
 */

const logApiError = mock((..._args: unknown[]): void => {});
const telegramApi: Record<string, unknown> = {};

mock.module("../../packages/infra/telegram/client", () => ({
  bot: { api: telegramApi },
  telegramApi,
  logApiError,
}));
mock.module("../../packages/infra/selfSentTracker", () => ({ markSelfSent: (): void => {} }));

const actions = await import("../../packages/infra/telegram/actions");
const membership = await import("../../packages/infra/telegram/actions/membership");

beforeEach(() => {
  logApiError.mockClear();
});

describe("封禁结果的 PARTICIPANT_ID_INVALID 分档", () => {
  test("PARTICIPANT_ID_INVALID 单独成档，照常记 API 错误；不关心它的动作仍归入 failed", async () => {
    const participantInvalid = (): never => {
      throw new GrammyError("x", { ok: false, error_code: 400, description: "Bad Request: PARTICIPANT_ID_INVALID" }, "banChatMember", {});
    };
    const banChatMember = mock(async (..._args: unknown[]): Promise<never> => participantInvalid());
    const unbanChatMember = mock(async (..._args: unknown[]): Promise<never> => participantInvalid());
    const banChatSenderChat = mock(async (..._args: unknown[]): Promise<never> => participantInvalid());
    const api: Api = { banChatMember, unbanChatMember, banChatSenderChat } as unknown as Api;

    expect(await actions.banChatMemberWithOutcome(-1001, 7, api)).toBe("participantInvalid");
    expect(logApiError).toHaveBeenCalledTimes(1);
    expect(await actions.banChatMember(-1001, 7, api)).toBeFalse();
    expect(await actions.banChatSenderChatWithOutcome(-1001, -4004, api)).toBe("failed");
    expect(await actions.kickChatMemberWithOutcome({ chatId: -1001, userId: 7, isSupergroup: true, api })).toBe("failed");
  });
});

describe("成员探测的 PARTICIPANT_ID_INVALID 分档", () => {
  function memberApi(getChatMember: (...args: unknown[]) => Promise<unknown>): Api {
    return { getChatMember: mock(getChatMember) } as unknown as Api;
  }

  function participantInvalid(): never {
    throw new GrammyError("x", { ok: false, error_code: 400, description: "Bad Request: PARTICIPANT_ID_INVALID" }, "getChatMember", {});
  }

  test("带结局的探测区分在群、离群、认不出 ID 与其它失败，失败都记 API 错误", async () => {
    expect(await membership.probeChatMembershipWithOutcome(-1001, 7, memberApi(async () => ({ status: "member" })))).toBe("present");
    expect(await membership.probeChatMembershipWithOutcome(-1001, 7, memberApi(async () => ({ status: "left" })))).toBe("absent");
    expect(logApiError).not.toHaveBeenCalled();

    expect(await membership.probeChatMembershipWithOutcome(-1001, 7, memberApi(async () => participantInvalid()))).toBe("participantInvalid");
    expect(await membership.probeChatMembershipWithOutcome(-1001, 7, memberApi(async () => {
      throw new GrammyError("x", { ok: false, error_code: 400, description: "Bad Request: user not found" }, "getChatMember", {});
    }))).toBe("failed");
    expect(logApiError).toHaveBeenCalledTimes(2);
  });

  test("三态探测把 PARTICIPANT_ID_INVALID 仍归为查询失败", async () => {
    expect(await membership.probeChatMembership(-1001, 7, memberApi(async () => ({ status: "member" })))).toBeTrue();
    expect(await membership.probeChatMembership(-1001, 7, memberApi(async () => ({ status: "kicked" })))).toBeFalse();
    expect(await membership.probeChatMembership(-1001, 7, memberApi(async () => participantInvalid()))).toBeUndefined();
  });

  test("/wed 复核读取把 PARTICIPANT_ID_INVALID 当作离群且不记 API 错误", async () => {
    const getChatMember = mock(async (..._args: unknown[]): Promise<unknown> => participantInvalid());
    Object.assign(telegramApi, { getChatMember });
    try {
      expect(await membership.readPresentChatUser({ chatId: -1001, userId: 7 })).toBeNull();
      expect(logApiError).not.toHaveBeenCalled();

      getChatMember.mockImplementation(async (): Promise<never> => { throw new Error("socket hang up"); });
      expect(await membership.readPresentChatUser({ chatId: -1001, userId: 7 })).toBeUndefined();
      expect(logApiError).toHaveBeenCalledTimes(1);

      const user = { id: 7, is_bot: false, first_name: "Ada" };
      getChatMember.mockImplementation(async (): Promise<unknown> => ({ status: "member", user }));
      expect(await membership.readPresentChatUser({ chatId: -1001, userId: 7 })).toEqual(user);
    } finally {
      Reflect.deleteProperty(telegramApi, "getChatMember");
    }
  });
});
