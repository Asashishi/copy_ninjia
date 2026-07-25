import { beforeEach, describe, expect, mock, test } from "bun:test";

const getActiveCopyIn = mock((_chatId: number): { copiedUser: { id: number } } | null => ({
  copiedUser: { id: 42 },
}));
const enqueueReaction = mock(async (..._args: unknown[]): Promise<void> => {});

mock.module("../../packages/infra/storage/stateStore", () => ({ getActiveCopyIn }));
mock.module("../../packages/copy/reactionQueue", () => ({ enqueueReaction }));

const { handleReaction } = await import("../../packages/auto/reactionSync");

function context(
  reactions: Record<string, string[]>,
  actor: { userId?: number; actorChatId?: number } = { userId: 42 }
): never {
  return {
    update: { update_id: 99 },
    messageReaction: {
      chat: { id: -1001 },
      message_id: 7,
      date: 123,
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
  getActiveCopyIn.mockClear();
  enqueueReaction.mockClear();
  getActiveCopyIn.mockImplementation(() => ({ copiedUser: { id: 42 } }));
  enqueueReaction.mockImplementation(async (): Promise<void> => {});
});

describe("reaction sync update entry", () => {
  test("只接收当前复制目标，并等待对应队列版本结算", async () => {
    let release!: () => void;
    enqueueReaction.mockImplementationOnce(async (): Promise<void> => await new Promise<void>((resolve) => {
      release = resolve;
    }));
    let settled: boolean = false;
    const handled = handleReaction(context({ emojiAdded: ["🔥"] })).finally(() => { settled = true; });

    await Bun.sleep(0);
    expect(settled).toBeFalse();
    expect(enqueueReaction).toHaveBeenCalledWith({
      chatId: -1001,
      messageId: 7,
      reactions: [{ type: "emoji", emoji: "🔥" }],
      updateId: 99,
      reactedAtUnix: 123,
    });
    release();
    await handled;

    await handleReaction(context({ emojiAdded: ["👍"] }, { userId: 7 }));
    getActiveCopyIn.mockReturnValueOnce(null);
    await handleReaction(context({ emojiAdded: ["👍"] }));
    expect(enqueueReaction).toHaveBeenCalledTimes(1);
  });

  test("按新增、自定义、剩余与清除的优先级生成单个可复制反应", async () => {
    await handleReaction(context({ emoji: ["👍"], customEmojiAdded: ["custom-1"] }, { actorChatId: 42 }));
    await handleReaction(context({ customEmoji: ["custom-2"] }));
    await handleReaction(context({ emojiRemoved: ["😁"] }));
    await handleReaction(context({}));

    expect(enqueueReaction.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ reactions: [{ type: "custom_emoji", custom_emoji_id: "custom-1" }] }),
      expect.objectContaining({ reactions: [{ type: "custom_emoji", custom_emoji_id: "custom-2" }] }),
      expect.objectContaining({ reactions: [] }),
    ]);
  });
});
