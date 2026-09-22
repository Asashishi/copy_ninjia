import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { User } from "grammy/types";
import type { CachedUser } from "../../packages/types/chatState";
import type { CurrentAvatarResult } from "../../packages/types/telegram";

const sendCommandMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const sendCommandPhoto = mock(async (..._args: unknown[]): Promise<number | undefined> => 2);
let memberUser: User | undefined;
const readChatMemberUser = mock(async (..._args: unknown[]): Promise<User | undefined> => memberUser);
let avatar: CurrentAvatarResult = { status: "permanent-failure" };
const readCurrentAvatar = mock(async (..._args: unknown[]): Promise<CurrentAvatarResult> => avatar);
let chatInfo: unknown;
const getChat = mock(async (..._args: unknown[]): Promise<unknown> => {
  if (chatInfo === undefined) throw new Error("Bad Request: chat not found");
  return chatInfo;
});
let resolvedTarget: CachedUser | undefined;
const resolveCommandTarget = mock(async (..._args: unknown[]): Promise<CachedUser | undefined> => resolvedTarget);

mock.module("../../packages/infra/telegram", () => ({ sendCommandMessage }));
mock.module("../../packages/infra/telegram/commandPhotos", () => ({ sendCommandPhoto }));
mock.module("../../packages/infra/telegram/actions/membership", () => ({ readChatMemberUser }));
mock.module("../../packages/infra/telegram/avatar/read", () => ({ readCurrentAvatar }));
mock.module("../../packages/infra/telegram/mainClient", () => ({ bot: { api: { getChat } } }));
mock.module("../../packages/commands/targetResolution", () => ({ resolveCommandTarget }));

const { handleInfoCommand } = await import("../../packages/commands/info");
const { drainDeferredCommandRuntime, initDeferredCommandRuntime } = await import("../../packages/commands/deferredCommands");
const { deferredCommandRuntime } = await import("../../packages/cache/main/deferredCommands");
const { chatAtmosphere } = await import("../../packages/infra/atmosphere");

const CHAT_ID: number = -1001;
const BOT: User = { id: 999, is_bot: true, first_name: "Copy", last_name: "Ninjia", username: "copy_ninjia_bot" };
const texts = chatAtmosphere(CHAT_ID).INFO_TEXTS;

function context(match: string = ""): never {
  return {
    chat: { id: CHAT_ID, type: "supergroup" },
    msgId: 10,
    msg: { message_id: 10, chat: { id: CHAT_ID, type: "supergroup" } },
    match,
    me: BOT,
  } as never;
}

async function runInfo(match: string = ""): Promise<void> {
  await handleInfoCommand(context(match));
  expect(await drainDeferredCommandRuntime(5_000)).toBe("flushed");
  // 排空会停止接纳；同一用例里再查一次要换一代执行器。
  initDeferredCommandRuntime();
}

/** 期望回执的资料。 */
interface ExpectedInfo {
  readonly name: string;
  readonly username: string;
  readonly id: number;
  readonly withAvatar: boolean;
}

/** 期望的正文与 id 的 code 实体。 */
function expected({ name, username, id, withAvatar }: ExpectedInfo): { text: string; entities: unknown[] } {
  const head: string = `名称：${name}\n用户名：${username}\nID：`;
  return {
    text: withAvatar ? `${head}${id}` : `${head}${id}\n头像：无`,
    entities: [{ type: "code", offset: head.length, length: String(id).length }],
  };
}

beforeEach(() => {
  for (const mocked of [sendCommandMessage, sendCommandPhoto, readChatMemberUser, readCurrentAvatar, getChat, resolveCommandTarget]) {
    mocked.mockClear();
  }
  sendCommandPhoto.mockImplementation(async (): Promise<number | undefined> => 2);
  memberUser = undefined;
  avatar = { status: "permanent-failure" };
  chatInfo = undefined;
  resolvedTarget = undefined;
  deferredCommandRuntime.current = null;
  initDeferredCommandRuntime();
});

afterEach(async () => {
  await drainDeferredCommandRuntime(0);
});

describe("/info", () => {
  test("目标解析接受回复、@username、用户 id、会话 id，也允许机器人自己", async () => {
    await handleInfoCommand(context("@alice"));
    expect(resolveCommandTarget.mock.calls[0]![0]).toMatchObject({
      chatId: CHAT_ID, rawArgument: "@alice", botUserId: 999, acceptUserId: true, acceptChatId: true, allowSelfTarget: true,
    });
    expect(sendCommandMessage).not.toHaveBeenCalled();
  });

  test("用户：现查本群成员身份，名称拼接 first 与 last，带头像时发图、id 用 code 实体", async () => {
    resolvedTarget = { id: 42, username: "stale" };
    memberUser = { id: 42, is_bot: false, first_name: "Alice", last_name: "Liddell", username: "alice" };
    avatar = { status: "ok", identity: memberUser, photo: "avatar-file-id" };
    await runInfo("42");
    expect(readChatMemberUser).toHaveBeenCalledWith(expect.objectContaining({ chatId: CHAT_ID, userId: 42 }));
    expect(readCurrentAvatar.mock.calls[0]![0]).toBe(memberUser);
    const message = expected({ name: "Alice Liddell", username: "@alice", id: 42, withAvatar: true });
    expect(sendCommandPhoto).toHaveBeenCalledWith({
      chatId: CHAT_ID, photo: "avatar-file-id", caption: message.text, captionEntities: message.entities,
      replyToMessageId: 10, messageThreadId: undefined,
    });
    expect(sendCommandMessage).not.toHaveBeenCalled();
  });

  test("没有头像或带图发送失败时回纯文字，注明头像：无", async () => {
    resolvedTarget = { id: 42 };
    memberUser = { id: 42, is_bot: false, first_name: "Alice" };
    await runInfo("42");
    expect(sendCommandMessage).toHaveBeenLastCalledWith({
      chatId: CHAT_ID, ...expected({ name: "Alice", username: "无", id: 42, withAvatar: false }), replyToMessageId: 10, messageThreadId: undefined,
    });

    avatar = { status: "ok", identity: memberUser, photo: new Uint8Array([1]) };
    sendCommandPhoto.mockImplementation(async (): Promise<number | undefined> => undefined);
    await runInfo("42");
    expect(sendCommandPhoto).toHaveBeenCalledTimes(1);
    expect(sendCommandMessage).toHaveBeenCalledTimes(2);
    expect(sendCommandMessage).toHaveBeenLastCalledWith(expect.objectContaining({ text: expected({ name: "Alice", username: "无", id: 42, withAvatar: false }).text }));
  });

  test("机器人自己：直接用自身资料，不再现查成员身份", async () => {
    resolvedTarget = { id: 999 };
    await runInfo();
    expect(readChatMemberUser).not.toHaveBeenCalled();
    expect(readCurrentAvatar.mock.calls[0]![0]).toBe(BOT);
    expect(sendCommandMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expected({ name: "Copy Ninjia", username: "@copy_ninjia_bot", id: 999, withAvatar: false }).text }));
  });

  test("频道：getChat 取 title 与用户名，按 id 读头像；群身份没有头像可读", async () => {
    resolvedTarget = { id: -1002, isChannel: true };
    chatInfo = { id: -1002, type: "channel", title: "News", username: "news" };
    await runInfo("-1002");
    expect(readCurrentAvatar.mock.calls[0]![0]).toBe(-1002);
    expect(sendCommandMessage).toHaveBeenLastCalledWith(expect.objectContaining({ text: expected({ name: "News", username: "@news", id: -1002, withAvatar: false }).text }));

    readCurrentAvatar.mockClear();
    chatInfo = { id: -1003, type: "supergroup", title: "Group" };
    resolvedTarget = { id: -1003, isChannel: true };
    await runInfo("-1003");
    expect(readCurrentAvatar).not.toHaveBeenCalled();
  });

  test("现查失败时退回解析得到的身份；连名称和用户名都没有时回查不到", async () => {
    resolvedTarget = { id: 42, first_name: "Cached", username: "cached" };
    await runInfo("42");
    expect(sendCommandMessage).toHaveBeenLastCalledWith(expect.objectContaining({ text: expected({ name: "Cached", username: "@cached", id: 42, withAvatar: false }).text }));

    resolvedTarget = { id: 43 };
    await runInfo("43");
    expect(sendCommandMessage).toHaveBeenLastCalledWith({ chatId: CHAT_ID, text: texts.notFound, replyToMessageId: 10 });
  });

  test("名称里的命令与双向控制字符被中和", async () => {
    resolvedTarget = { id: 42 };
    memberUser = { id: 42, is_bot: false, first_name: "/batch_kick", last_name: "‮evil" };
    await runInfo("42");
    const text: string = (sendCommandMessage.mock.calls[0]![0] as { text: string }).text;
    expect(text).not.toContain("/batch_kick");
    expect(text).not.toContain("‮");
  });

  test("执行器停止接纳时回「稍后再试」", async () => {
    resolvedTarget = { id: 42 };
    deferredCommandRuntime.current!.accepting = false;
    await handleInfoCommand(context("42"));
    expect(sendCommandMessage).toHaveBeenCalledWith({ chatId: CHAT_ID, text: texts.busy, replyToMessageId: 10 });
  });
});
