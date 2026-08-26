import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../helpers/loggerMock";

const activeCopyTargetIdIn = mock((_chatId: number): number | undefined => 42);
const setMessageReactions = mock(async (..._args: unknown[]): Promise<boolean> => true);
const loggerLog = mock((..._args: unknown[]): void => {});

mock.module("../../packages/infra/storage/stateStore", () => ({ activeCopyTargetIdIn }));
mock.module("../../packages/infra/telegram", () => ({ setMessageReactions }));
mock.module("../../packages/infra/logger", () => ({ logger: loggerStub({ log: loggerLog }) }));

const { handleReaction } = await import("../../packages/auto/reactionSync");

function context(
  reactions: Record<string, string[]>,
  actor: { userId?: number; actorChatId?: number } = { userId: 42 }
): never {
  return {
    messageReaction: {
      chat: { id: -1001 },
      message_id: 7,
      date: Math.floor(Date.now() / 1000),
      ...(actor.actorChatId === undefined ? {} : { actor_chat: { id: actor.actorChatId } }),
      ...(actor.userId === undefined ? {} : { user: { id: actor.userId } }),
    },
    reactions: () => ({
      emoji: [],
      emojiAdded: [],
      emojiRemoved: [],
      customEmoji: [],
      customEmojiAdded: [],
      customEmojiRemoved: [],
      ...reactions,
    }),
  } as never;
}

beforeEach(() => {
  activeCopyTargetIdIn.mockClear();
  setMessageReactions.mockClear();
  loggerLog.mockClear();
  activeCopyTargetIdIn.mockImplementation((): number | undefined => 42);
  setMessageReactions.mockImplementation(async (): Promise<boolean> => true);
});

describe("reaction sync update entry", () => {
  test("只接收当前复制目标，并等待 Telegram 动作结算", async () => {
    let release!: () => void;
    setMessageReactions.mockImplementationOnce(async (): Promise<boolean> =>
      await new Promise<boolean>((resolve: (value: boolean) => void): void => {
        release = (): void => resolve(true);
      })
    );
    let settled: boolean = false;
    const handled: Promise<void> = handleReaction(context({ emojiAdded: ["🔥"] }))
      .finally((): void => { settled = true; });

    await Bun.sleep(0);
    expect(settled).toBeFalse();
    expect(setMessageReactions).toHaveBeenCalledWith({
      chatId: -1001,
      messageId: 7,
      reactions: [{ type: "emoji", emoji: "🔥" }],
    });
    release();
    await handled;
    expect(loggerLog).toHaveBeenCalledTimes(1);

    await handleReaction(context({ emojiAdded: ["👍"] }, { userId: 7 }));
    activeCopyTargetIdIn.mockReturnValueOnce(undefined);
    await handleReaction(context({ emojiAdded: ["👍"] }));
    expect(setMessageReactions).toHaveBeenCalledTimes(1);
  });

  test("按新增、自定义、剩余与清除的优先级生成单个可复制反应", async () => {
    await handleReaction(context({ emoji: ["👍"], customEmojiAdded: ["custom-1"] }, { actorChatId: 42 }));
    await handleReaction(context({ customEmoji: ["custom-2"] }));
    await handleReaction(context({ emojiRemoved: ["😁"] }));
    await handleReaction(context({}));

    expect(setMessageReactions.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ reactions: [{ type: "custom_emoji", custom_emoji_id: "custom-1" }] }),
      expect.objectContaining({ reactions: [{ type: "custom_emoji", custom_emoji_id: "custom-2" }] }),
      expect.objectContaining({ reactions: [] }),
    ]);
  });

  test("Telegram 动作失败时不记录成功延迟", async () => {
    setMessageReactions.mockResolvedValueOnce(false);

    await handleReaction(context({ emojiAdded: ["👍"] }));

    expect(loggerLog).not.toHaveBeenCalled();
  });
});
