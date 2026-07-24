import { beforeEach, describe, expect, test } from "bun:test";
import type { Message } from "@grammyjs/types";
import { senderUsernameCache, userCache } from "../../src/cache/senderIdentity";
import { USER_CACHE_MAX } from "../../src/consts/senderIdentity";
import {
  cacheSender,
  resolveReplyTarget,
  resolveUsernameTarget,
  seedSenderCache,
} from "../../src/users/senderIdentity";

const chat = { id: -1001, type: "supergroup", title: "Test Group" } as const;

function userMessage(id: number, username?: string): Message {
  return {
    message_id: 1,
    date: 1,
    chat,
    from: { id, is_bot: false, first_name: `User ${id}`, username },
  } as unknown as Message;
}

function senderChatMessage(id: number, username?: string): Message {
  return {
    message_id: 1,
    date: 1,
    chat,
    from: { id: 999, is_bot: false, first_name: "Anonymous" },
    sender_chat: { id, type: "channel", title: `Channel ${id}`, username },
  } as unknown as Message;
}

beforeEach(() => {
  userCache.clear();
  senderUsernameCache.clear();
});

describe("sender identity cache", () => {
  test("回复当前群组皮套消息时保留群身份，供 copy 复制头像并复读", () => {
    const repliedMessage = {
      message_id: 1,
      date: 1,
      chat,
      sender_chat: chat,
    } as unknown as Message;
    const commandMessage = {
      message_id: 2,
      date: 1,
      chat,
      reply_to_message: repliedMessage,
    } as unknown as Message;

    expect(resolveReplyTarget(commandMessage)).toEqual({
      id: -1001,
      title: "Test Group",
      isChannel: true,
    });
  });

  test("用户改名、去名和恢复 username 时只有当前 alias 可解析", () => {
    cacheSender(userMessage(1, "OldName"));
    expect(resolveUsernameTarget("OLDNAME")?.id).toBe(1);
    expect(senderUsernameCache.get(1)).toBe("oldname");

    cacheSender(userMessage(1, "NewName"));
    expect(resolveUsernameTarget("oldname")).toBeUndefined();
    expect(resolveUsernameTarget("NEWNAME")?.username).toBe("NewName");
    expect(senderUsernameCache.get(1)).toBe("newname");

    cacheSender(userMessage(1));
    expect(resolveUsernameTarget("newname")).toBeUndefined();
    expect(senderUsernameCache.has(1)).toBe(false);

    cacheSender(userMessage(1, "RestoredName"));
    expect(resolveUsernameTarget("oldname")).toBeUndefined();
    expect(resolveUsernameTarget("newname")).toBeUndefined();
    expect(resolveUsernameTarget("RESTOREDNAME")?.id).toBe(1);
    expect(userCache.size).toBe(1);
  });

  test("username 转移给另一用户时撤销旧用户的反向映射", () => {
    cacheSender(userMessage(1, "SharedName"));
    cacheSender(userMessage(2, "sharedname"));

    expect(resolveUsernameTarget("SHAREDNAME")?.id).toBe(2);
    expect(senderUsernameCache.has(1)).toBe(false);
    expect(senderUsernameCache.get(2)).toBe("sharedname");
    expect(userCache.size).toBe(1);
  });

  test("频道 sender_chat 改名和去名时同步清理 alias", () => {
    cacheSender(senderChatMessage(-1009, "OldChannel"));
    expect(resolveUsernameTarget("oldchannel")).toMatchObject({
      id: -1009,
      title: "Channel -1009",
      isChannel: true,
    });

    cacheSender(senderChatMessage(-1009, "NewChannel"));
    expect(resolveUsernameTarget("oldchannel")).toBeUndefined();
    expect(resolveUsernameTarget("NEWCHANNEL")?.id).toBe(-1009);

    cacheSender(senderChatMessage(-1009));
    expect(resolveUsernameTarget("newchannel")).toBeUndefined();
    expect(senderUsernameCache.has(-1009)).toBe(false);
  });

  test("大小写归一化不创建重复 key，启动预热复用改名规则", () => {
    seedSenderCache({ id: 7, username: "MixedCase", first_name: "Before" });
    seedSenderCache({ id: 7, username: "MIXEDCASE", first_name: "After" });

    expect(userCache.size).toBe(1);
    expect(resolveUsernameTarget("mixedcase")).toMatchObject({
      id: 7,
      username: "MIXEDCASE",
      first_name: "After",
    });

    seedSenderCache({ id: 7, username: "Renamed", first_name: "After" });
    expect(resolveUsernameTarget("mixedcase")).toBeUndefined();
    expect(resolveUsernameTarget("RENAMED")?.id).toBe(7);
    expect(senderUsernameCache.get(7)).toBe("renamed");

    seedSenderCache({ id: 7, first_name: "After" });
    expect(resolveUsernameTarget("renamed")).toBeUndefined();
    expect(senderUsernameCache.has(7)).toBe(false);
  });

  test("达到容量上限后淘汰正向条目及对应反向索引", () => {
    for (let index = 0; index < USER_CACHE_MAX; index++) {
      seedSenderCache({ id: 10_000 + index, username: `user_${index}` });
    }

    seedSenderCache({ id: 99_999, username: "overflow_user" });

    expect(userCache.size).toBe(USER_CACHE_MAX);
    expect(senderUsernameCache.size).toBe(USER_CACHE_MAX);
    expect(resolveUsernameTarget("user_0")).toBeUndefined();
    expect(senderUsernameCache.has(10_000)).toBe(false);
    expect(resolveUsernameTarget("overflow_user")?.id).toBe(99_999);
    for (const [username, identity] of userCache) {
      expect(senderUsernameCache.get(identity.id)).toBe(username);
    }
  });

  test("解析拒绝并清理缺少匹配反向索引的已知不一致 alias", () => {
    userCache.set("stale_name", { id: 42, username: "stale_name" });

    expect(resolveUsernameTarget("STALE_NAME")).toBeUndefined();
    expect(userCache.has("stale_name")).toBe(false);
  });
});
