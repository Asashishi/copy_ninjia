import { afterEach, describe, expect, mock, test } from "bun:test";
import { GrammyError, InputFile, type Api } from "grammy";
import { sentMessages } from "../../packages/cache/perThread/selfSentTracker";
import { MUTED_CHAT_PERMISSIONS } from "../../packages/consts/telegram";
import {
  isChatMember,
  kickChatMemberWithOutcome,
  muteChatMemberWithOutcome,
  sendMessageWithResult,
  sendPhotoWithResult,
} from "../../packages/infra/telegram/actions";
import { isSelfSent } from "../../packages/infra/selfSentTracker";

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
    const api = { sendMessage: sendMessageMock } as unknown as Api;

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

  test("显式 entities 原样进入 payload，空数组则整个字段不出现", async () => {
    const sendMessageMock = mock(async (..._args: unknown[]) => ({ message_id: 88 }));
    const api = { sendMessage: sendMessageMock } as unknown as Api;
    // 富文本只能靠调用方算好的 entities 表达，绝不通过 parse_mode，
    // 见 docs/04-invariants.md 的出站消息约束。
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
    const api = { sendMessage: sendMessageMock } as unknown as Api;

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
    const api = { sendPhoto: sendPhotoMock } as unknown as Api;

    const sent = await sendPhotoWithResult({
      chatId: -1001,
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
      replyToMessageId: 42,
      api,
    });

    expect(sent).toEqual({ messageId: 78, repliedToMessageId: 42 });
    expect(sendPhotoMock).toHaveBeenCalledWith(-1001, expect.any(InputFile), {
      reply_parameters: { message_id: 42, allow_sending_without_reply: true },
    });
    expect(isSelfSent(-1001, 78)).toBe(true);
  });

  test("图注按 caption 随图发出，不设置 parse_mode", async () => {
    const sendPhotoMock = mock(async (..._args: unknown[]) => ({ message_id: 80 }));
    const api = { sendPhoto: sendPhotoMock } as unknown as Api;

    await sendPhotoWithResult({
      chatId: -1001,
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/jpeg",
      api,
      caption: "照着你说的画了一张 <b>不该被解析</b>",
    });

    // 图注是自由文本，一旦按 HTML/Markdown 解析就会形成注入，并让未闭合的
    // 实体把整条发送打回；这里必须只有 caption 一个字段。
    expect(sendPhotoMock).toHaveBeenCalledWith(-1001, expect.any(InputFile), {
      caption: "照着你说的画了一张 <b>不该被解析</b>",
    });
  });

  test("没有图注时不带 caption 字段", async () => {
    const sendPhotoMock = mock(async (..._args: unknown[]) => ({ message_id: 81 }));
    const api = { sendPhoto: sendPhotoMock } as unknown as Api;

    await sendPhotoWithResult({
      chatId: -1001,
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
      api,
    });

    expect(sendPhotoMock.mock.calls[0]?.[2]).not.toHaveProperty("caption");
  });

  test("正确区分当前成员、受限成员和已离开成员", async () => {
    const apiFor = (member: unknown): Api =>
      ({ getChatMember: mock(async (..._args: unknown[]) => member) }) as unknown as Api;

    expect(await isChatMember(-1001, 1, apiFor({ status: "member" }))).toBe(true);
    expect(await isChatMember(-1001, 2, apiFor({ status: "administrator" }))).toBe(true);
    expect(await isChatMember(-1001, 3, apiFor({ status: "restricted", is_member: true }))).toBe(true);
    expect(await isChatMember(-1001, 4, apiFor({ status: "restricted", is_member: false }))).toBe(false);
    expect(await isChatMember(-1001, 5, apiFor({ status: "left" }))).toBe(false);
  });

  test("禁言收走全部发言权限，截止时刻向上取整到秒", async () => {
    const restrictMock = mock(async (..._args: unknown[]) => true as const);
    const api = { restrictChatMember: restrictMock } as unknown as Api;

    // 1500 ms 落在两秒之间：向下取整会把时长抹短，而 Bot API 把「距现在不足
    // 30 秒」的 until_date 当成永久限制，边界上宁可多一秒。
    expect(await muteChatMemberWithOutcome({ chatId: -1001, userId: 7, mutedUntil: 1_500, api })).toBe("muted");
    expect(restrictMock).toHaveBeenCalledWith(-1001, 7, MUTED_CHAT_PERMISSIONS, { until_date: 2 });
    // 权限集里不允许有任何一项为真，否则那不叫禁言。
    expect(Object.values(MUTED_CHAT_PERMISSIONS).every((allowed: boolean | undefined): boolean => allowed === false))
      .toBe(true);
  });

  test("明确的拒绝与偶发失败分成两档，调用方据此决定要不要重试", async () => {
    const failWith = (error: unknown): Api => ({
      restrictChatMember: mock(async (..._args: unknown[]) => { throw error; }),
    }) as unknown as Api;
    const mute = (api: Api): Promise<string> =>
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

  test("踢人结果保留成功、权限拒绝与瞬时失败三态", async () => {
    const kickWith = (result: true | unknown): Api => ({
      unbanChatMember: mock(async (..._args: unknown[]): Promise<true> => {
        if (result !== true) throw result;
        return true;
      }),
    }) as unknown as Api;

    expect(await kickChatMemberWithOutcome(
      -1001,
      7,
      kickWith(true)
    )).toBe("kicked");
    expect(await kickChatMemberWithOutcome(
      -1001,
      7,
      kickWith(new GrammyError(
        "Bad Request: not enough rights",
        {
          ok: false,
          error_code: 400,
          description: "Bad Request: not enough rights",
        },
        "unbanChatMember",
        {}
      ))
    )).toBe("forbidden");
    expect(await kickChatMemberWithOutcome(
      -1001,
      7,
      kickWith(new Error("socket hang up"))
    )).toBe("failed");
  });
});
