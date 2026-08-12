import { afterEach, describe, expect, mock, test } from "bun:test";
import { GrammyError } from "grammy";
import type { TelegramApi } from "../../packages/types/telegramWorker";
import { sentMessages } from "../../packages/cache/perThread/selfSentTracker";
import { MUTED_CHAT_PERMISSIONS } from "../../packages/consts/telegram";
import {
  deleteEphemeralMessageWithOutcome,
  isChatMember,
  kickChatMemberWithOutcome,
  muteChatMemberWithOutcome,
  probeChatAdmin,
  probeChatMembership,
  sendEphemeralMessage,
  sendMessageWithResult,
  sendPhotoWithResult,
} from "../../packages/infra/telegram/actions";
import { isSelfSent } from "../../packages/infra/selfSentTracker";
import { TelegramRetryPreconditionChangedError } from "../../packages/infra/telegram/errors";

afterEach(() => {
  for (const timer of sentMessages.values()) clearTimeout(timer);
  sentMessages.clear();
});

describe("Telegram 常规动作封装", () => {
  test("发送文字时返回服务端实际建立的回复关系，并登记自发消息", async () => {
    const sendMessageMock = mock(async (..._args: unknown[]) => ({
      message_id: 77,
      reply_to_message: { message_id: 42 },
    }));
    const api = { sendMessage: sendMessageMock } as unknown as TelegramApi;

    const sent = await sendMessageWithResult({
      chatId: -1001,
      text: "hello",
      replyToMessageId: 42,
      api,
    });

    expect(sent).toEqual({ messageId: 77, repliedToMessageId: 42 });
    expect(sendMessageMock).toHaveBeenCalledWith(-1001, "hello", {
      reply_parameters: { message_id: 42, allow_sending_without_reply: true },
    });
    expect(isSelfSent(-1001, 77)).toBe(true);
  });

  test("目标专属临时消息透传 Bot API 10.2 字段且不登记 message_id 0", async () => {
    const sendMessageMock = mock(async (..._args: unknown[]) => ({
      message_id: 0,
      chat: { id: -1001 },
      receiver_user: { id: 7 },
      ephemeral_message_id: 71,
    }));
    const api = { sendMessage: sendMessageMock } as unknown as TelegramApi;
    const keyboard = {
      inline_keyboard: [[{
        text: "发言",
        switch_inline_query_current_chat: "",
      }]],
    };

    expect(await sendEphemeralMessage({
      chatId: -1001,
      receiverUserId: 7,
      text: "只给目标看的入口",
      keyboard,
      api,
    })).toBe(71);
    expect(sendMessageMock).toHaveBeenCalledWith(-1001, "只给目标看的入口", {
      receiver_user_id: 7,
      reply_markup: keyboard,
    });
    expect(sentMessages.size).toBe(0);
  });

  test("目标专属临时消息只接受群、接收者和临时 id 全部匹配的响应", async () => {
    const responses: readonly Readonly<Record<string, unknown>>[] = [
      {
        message_id: 1,
        chat: { id: -1001 },
        receiver_user: { id: 7 },
        ephemeral_message_id: 71,
      },
      {
        message_id: 0,
        chat: { id: -1002 },
        receiver_user: { id: 7 },
        ephemeral_message_id: 71,
      },
      {
        message_id: 0,
        chat: { id: -1001 },
        receiver_user: { id: 8 },
        ephemeral_message_id: 71,
      },
      {
        message_id: 0,
        chat: { id: -1001 },
        receiver_user: { id: 7 },
        ephemeral_message_id: 0,
      },
    ];
    const keyboard = { inline_keyboard: [] };
    for (const response of responses) {
      const api = {
        sendMessage: mock(async (..._args: unknown[]) => response),
      } as unknown as TelegramApi;
      expect(await sendEphemeralMessage({
        chatId: -1001,
        receiverUserId: 7,
        text: "入口",
        keyboard,
        api,
      })).toBeUndefined();
    }
    expect(sentMessages.size).toBe(0);
  });

  test("目标专属临时消息按群、接收者和临时 id 定向删除", async () => {
    const deleteEphemeralMessage = mock(async (..._args: unknown[]): Promise<true> => true);
    const api = { deleteEphemeralMessage } as unknown as TelegramApi;

    expect(await deleteEphemeralMessageWithOutcome({
      chatId: -1001,
      receiverUserId: 7,
      ephemeralMessageId: 71,
      api,
    })).toBe("deleted");
    expect(deleteEphemeralMessage).toHaveBeenCalledWith({
      chatId: -1001,
      receiverUserId: 7,
      ephemeralMessageId: 71,
    });
  });

  test("目标专属临时消息已不存在时按清理完成结算", async () => {
    const deleteEphemeralMessage = mock(
      async (..._args: unknown[]): Promise<never> => {
        throw new GrammyError(
          "Bad Request: ephemeral message not found",
          {
            ok: false,
            error_code: 400,
            description: "Bad Request: ephemeral message not found",
          },
          "deleteEphemeralMessage",
          {}
        );
      }
    );
    const api = { deleteEphemeralMessage } as unknown as TelegramApi;

    expect(await deleteEphemeralMessageWithOutcome({
      chatId: -1001,
      receiverUserId: 7,
      ephemeralMessageId: 71,
      api,
    })).toBe("gone");
  });

  test("显式 entities 原样进入 payload，空数组则整个字段不出现", async () => {
    const sendMessageMock = mock(async (..._args: unknown[]) => ({ message_id: 88 }));
    const api = { sendMessage: sendMessageMock } as unknown as TelegramApi;
    // 富文本只能靠调用方算好的 entities 表达，绝不通过 parse_mode，
    // 见 docs/cn/04-invariants.md 的出站消息约束。
    const entities = [{ type: "text_link" as const, offset: 0, length: 3, url: "https://t.me/foo" }];

    await sendMessageWithResult({ chatId: -1001, text: "abc def", entities, api });
    expect(sendMessageMock).toHaveBeenLastCalledWith(-1001, "abc def", { entities });
    // 传入的只读数组不能被后续改动波及，payload 必须是自己的副本。
    expect((sendMessageMock.mock.calls[0]![2] as { entities: unknown[] }).entities).not.toBe(entities);

    await sendMessageWithResult({ chatId: -1001, text: "abc def", entities: [], api });
    expect(sendMessageMock).toHaveBeenLastCalledWith(-1001, "abc def", {});
    // 任何一条路径都不得设置 parse_mode。
    for (const call of sendMessageMock.mock.calls) {
      expect(call[2]).not.toHaveProperty("parse_mode");
    }
  });

  test("回复目标已删除时仍发送文字，但结果不伪造回复关系", async () => {
    const sendMessageMock = mock(async (..._args: unknown[]) => ({ message_id: 79 }));
    const api = { sendMessage: sendMessageMock } as unknown as TelegramApi;

    const sent = await sendMessageWithResult({
      chatId: -1001,
      text: "hello",
      replyToMessageId: 42,
      api,
    });

    expect(sent).toEqual({ messageId: 79 });
    expect(isSelfSent(-1001, 79)).toBe(true);
  });

  test("从内存上传生成图片，并返回服务端实际建立的回复关系", async () => {
    const sendPhotoMock = mock(async (..._args: unknown[]) => ({
      message_id: 78,
      reply_to_message: { message_id: 42 },
    }));
    const api = { sendPhoto: sendPhotoMock } as unknown as TelegramApi;

    const sent = await sendPhotoWithResult({
      chatId: -1001,
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
      replyToMessageId: 42,
      api,
    });

    expect(sent).toEqual({ messageId: 78, repliedToMessageId: 42 });
    expect(sendPhotoMock).toHaveBeenCalledWith(-1001, {
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "generated.png",
    }, {
      reply_parameters: { message_id: 42, allow_sending_without_reply: true },
    });
    expect(isSelfSent(-1001, 78)).toBe(true);
  });

  test("图注按 caption 随图发出，不设置 parse_mode", async () => {
    const sendPhotoMock = mock(async (..._args: unknown[]) => ({ message_id: 80 }));
    const api = { sendPhoto: sendPhotoMock } as unknown as TelegramApi;

    await sendPhotoWithResult({
      chatId: -1001,
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/jpeg",
      api,
      caption: "照着你说的画了一张 <b>不该被解析</b>",
    });

    // 图注是自由文本，一旦按 HTML/Markdown 解析就会形成注入，并让未闭合的
    // 实体把整条发送打回；这里必须只有 caption 一个字段。
    expect(sendPhotoMock).toHaveBeenCalledWith(-1001, {
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "generated.jpg",
    }, {
      caption: "照着你说的画了一张 <b>不该被解析</b>",
    });
  });

  test("没有图注时不带 caption 字段", async () => {
    const sendPhotoMock = mock(async (..._args: unknown[]) => ({ message_id: 81 }));
    const api = { sendPhoto: sendPhotoMock } as unknown as TelegramApi;

    await sendPhotoWithResult({
      chatId: -1001,
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
      api,
    });

    expect(sendPhotoMock.mock.calls[0]?.[2]).not.toHaveProperty("caption");
  });

  test("正确区分当前成员、受限成员和已离开成员", async () => {
    const apiFor = (member: unknown): TelegramApi =>
      ({ getChatMember: mock(async (..._args: unknown[]) => member) }) as unknown as TelegramApi;

    expect(await isChatMember(-1001, 1, apiFor({ status: "member" }))).toBe(true);
    expect(await isChatMember(-1001, 2, apiFor({ status: "administrator" }))).toBe(true);
    expect(await isChatMember(-1001, 3, apiFor({ status: "restricted", is_member: true }))).toBe(true);
    expect(await isChatMember(-1001, 4, apiFor({ status: "restricted", is_member: false }))).toBe(false);
    expect(await isChatMember(-1001, 5, apiFor({ status: "left" }))).toBe(false);
  });

  test("成员与管理员探测保留查询失败的 unknown，不把它压成否定结论", async () => {
    const apiFor = (member: unknown): TelegramApi =>
      ({ getChatMember: mock(async (..._args: unknown[]) => member) }) as unknown as TelegramApi;
    const failedApi = {
      getChatMember: mock(async (..._args: unknown[]): Promise<never> => {
        throw new Error("membership unavailable");
      }),
    } as unknown as TelegramApi;

    expect(await probeChatMembership(-1001, 1, apiFor({ status: "member" }))).toBe(true);
    expect(await probeChatMembership(-1001, 2, apiFor({ status: "left" }))).toBe(false);
    expect(await probeChatAdmin(-1001, 3, apiFor({ status: "creator" }))).toBe(true);
    expect(await probeChatAdmin(-1001, 4, apiFor({ status: "administrator" }))).toBe(true);
    expect(await probeChatAdmin(-1001, 5, apiFor({ status: "member" }))).toBe(false);
    expect(await probeChatMembership(-1001, 6, failedApi)).toBeUndefined();
    expect(await probeChatAdmin(-1001, 6, failedApi)).toBeUndefined();
    expect(await isChatMember(-1001, 6, failedApi)).toBe(false);
  });

  test("禁言收走全部发言权限，截止时刻向上取整到秒", async () => {
    const restrictMock = mock(async (..._args: unknown[]) => true as const);
    const api = { restrictChatMember: restrictMock } as unknown as TelegramApi;

    // 1500 ms 落在两秒之间：向下取整会把时长抹短，而 Bot API 把「距现在不足
    // 30 秒」的 until_date 当成永久限制，边界上宁可多一秒。
    expect(await muteChatMemberWithOutcome({ chatId: -1001, userId: 7, mutedUntil: 1_500, api })).toBe("muted");
    expect(restrictMock).toHaveBeenCalledWith(-1001, 7, MUTED_CHAT_PERMISSIONS, { until_date: 2 });
    // 权限集里不允许有任何一项为真，否则那不叫禁言。
    expect(Object.values(MUTED_CHAT_PERMISSIONS).every((allowed: boolean | undefined): boolean => allowed === false))
      .toBe(true);
  });

  test("明确的拒绝与偶发失败分成两档，调用方据此决定要不要重试", async () => {
    const failWith = (error: unknown): TelegramApi => ({
      restrictChatMember: mock(async (..._args: unknown[]) => { throw error; }),
    }) as unknown as TelegramApi;
    const mute = (api: TelegramApi): Promise<string> =>
      muteChatMemberWithOutcome({ chatId: -1001, userId: 7, mutedUntil: 60_000, api });

    // 缺 can_restrict_members 与「目标本身是管理员」共用这一句 400；两者都是
    // 「再试一次也一样」，归到 forbidden。
    expect(await mute(failWith(new GrammyError(
      "Bad Request: not enough rights",
      { ok: false, error_code: 400, description: "Bad Request: not enough rights" },
      "restrictChatMember",
      {}
    )))).toBe("forbidden");
    // 403 一律算：不在群、被踢出，共同点是这次调用永远不会成功。
    expect(await mute(failWith(new GrammyError(
      "Forbidden: bot was kicked",
      { ok: false, error_code: 403, description: "Forbidden: bot was kicked" },
      "restrictChatMember",
      {}
    )))).toBe("forbidden");
    // 限流/网络抖动值得等一等再来，不能和上面混成一档。
    expect(await mute(failWith(new Error("socket hang up")))).toBe("failed");
    expect(await mute(failWith(new GrammyError(
      "Too Many Requests",
      { ok: false, error_code: 429, description: "Too Many Requests: retry after 3" },
      "restrictChatMember",
      {}
    )))).toBe("failed");
  });

  test("踢人结果保留成功、目标离群、权限拒绝与瞬时失败四态", async () => {
    const kickWith = (result: true | unknown): TelegramApi => ({
      unbanChatMember: mock(async (..._args: unknown[]): Promise<true> => {
        if (result !== true) throw result;
        return true;
      }),
    }) as unknown as TelegramApi;

    expect(await kickChatMemberWithOutcome({
      chatId: -1001,
      userId: 7,
      isSupergroup: true,
      api: kickWith(true),
    })).toBe("kicked");
    expect(await kickChatMemberWithOutcome({
      chatId: -1001,
      userId: 7,
      isSupergroup: true,
      api: kickWith(new TelegramRetryPreconditionChangedError()),
    })).toBe("absent");
    expect(await kickChatMemberWithOutcome({
      chatId: -1001,
      userId: 7,
      isSupergroup: true,
      api: kickWith(new GrammyError(
        "Bad Request: not enough rights",
        {
          ok: false,
          error_code: 400,
          description: "Bad Request: not enough rights",
        },
        "unbanChatMember",
        {}
      )),
    })).toBe("forbidden");
    expect(await kickChatMemberWithOutcome({
      chatId: -1001,
      userId: 7,
      isSupergroup: true,
      api: kickWith(new Error("socket hang up")),
    })).toBe("failed");
  });

  test("确证是普通群时走 banChatMember，超级群走 unbanChatMember", async () => {
    // unbanChatMember 的官方说明是「unban a previously banned user in a
    // supergroup or channel」，普通群用不了；banChatMember 覆盖「a group, a
    // supergroup or a channel」，而「踢了回不来」那句只限超级群/频道，所以普通
    // 群里它就是一次纯移除。类型未知时调用方必须先查清楚，不允许在这里猜。
    const calls: string[] = [];
    const api = {
      unbanChatMember: async (): Promise<true> => { calls.push("unban"); return true; },
      banChatMember: async (): Promise<true> => { calls.push("ban"); return true; },
    } as unknown as TelegramApi;

    await kickChatMemberWithOutcome({ chatId: -1001, userId: 7, isSupergroup: true, api });
    await kickChatMemberWithOutcome({ chatId: -1001, userId: 7, isSupergroup: false, api });

    expect(calls).toEqual(["unban", "ban"]);
  });
});
