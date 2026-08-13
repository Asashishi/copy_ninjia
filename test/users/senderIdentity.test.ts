import { beforeEach, describe, expect, test } from "bun:test";
import type { Message } from "@grammyjs/types";
import { senderUsernameCache, userCache } from "../../packages/cache/main/senderIdentity";
import { USER_CACHE_MAX } from "../../packages/consts/senderIdentity";
import type { CachedUser } from "../../packages/types/chatState";
import {
  cacheSender,
  resolveIdTarget,
  resolveReplyTarget,
  resolveUsernameTarget,
  seedSenderCache,
} from "../../packages/users/senderIdentity";

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

  test("身份未变化时保留同一缓存对象，避免消息级重复刷新", () => {
    const message: Message = userMessage(3, "StableName");
    cacheSender(message);
    const cached: CachedUser | undefined = userCache.get("stablename");

    cacheSender(message);

    expect(userCache.get("stablename")).toBe(cached);
    expect(senderUsernameCache.get(3)).toBe("stablename");
  });

  test("无 username 的稳定发送者不进入任一索引", () => {
    const message: Message = userMessage(4);

    expect(cacheSender(message)).toBe(4);
    expect(cacheSender(message)).toBe(4);
    expect(userCache.size).toBe(0);
    expect(senderUsernameCache.size).toBe(0);
  });

  test("频道身份未变化时保留同一缓存对象", () => {
    const message: Message = senderChatMessage(-1008, "StableChannel");
    cacheSender(message);
    const cached: CachedUser | undefined = userCache.get("stablechannel");

    cacheSender(message);

    expect(userCache.get("stablechannel")).toBe(cached);
    expect(senderUsernameCache.get(-1008)).toBe("stablechannel");
  });

  test("username 不变但资料字段变化时照样刷新：守住快路径的比较清单", () => {
    // cacheSender 的快路径逐字段比对缓存条目（为的是每条群消息不白付一次对象
    // 分配），字段清单必须覆盖 resolveSenderIdentity 构造的全部字段：漏掉任何
    // 一个，该字段的变化都会被误判成「未变」，缓存从此停在旧资料上。
    const user: Message = userMessage(41, "ProfileUser");
    cacheSender(user);
    expect(userCache.get("profileuser")).toMatchObject({ first_name: "User 41" });

    const renamed: Message = userMessage(41, "ProfileUser");
    (renamed.from as { first_name: string }).first_name = "改名后";
    cacheSender(renamed);
    expect(userCache.get("profileuser")).toMatchObject({ first_name: "改名后" });

    const withLastName: Message = userMessage(41, "ProfileUser");
    (withLastName.from as { first_name: string; last_name?: string }).first_name = "改名后";
    (withLastName.from as { last_name?: string }).last_name = "新姓氏";
    cacheSender(withLastName);
    expect(userCache.get("profileuser")).toMatchObject({ last_name: "新姓氏" });

    const channel: Message = senderChatMessage(-1041, "ProfileChannel");
    cacheSender(channel);
    expect(userCache.get("profilechannel")).toMatchObject({ title: "Channel -1041" });

    const retitled: Message = senderChatMessage(-1041, "ProfileChannel");
    (retitled.sender_chat as { title: string }).title = "改名后的频道";
    cacheSender(retitled);
    expect(userCache.get("profilechannel")).toMatchObject({
      title: "改名后的频道",
      isChannel: true,
    });
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

describe("按裸 id 解析目标", () => {
  test("缓存里有就沿用那份身份，回执才有名字可念", () => {
    cacheSender(userMessage(42, "Alice_1"));
    expect(resolveIdTarget(42)).toEqual({ id: 42, username: "Alice_1", first_name: "User 42" });
  });

  test("缓存落空不是失败：id 本身就是权威目标，退化成只带 id 的最小身份", () => {
    // 与 @username 那条路的关键差别——用户名会被释放后由别人重新注册，
    // 而 id 不会改指另一个人，因此按 id 下的命令不必要求「这个人说过话」。
    expect(resolveIdTarget(4242)).toEqual({ id: 4242 });
  });

  test("负数 id 退化时带上 isChannel：解封接口按这个标记分派", () => {
    // 漏标就会拿一个负数去调 unbanChatMemberIfBanned，报错记进 failedCount，
    // 管理员收到一份关于「根本没被碰过的目标」的假战报（见 commands/unblock.ts）。
    expect(resolveIdTarget(-1002233445566)).toEqual({ id: -1002233445566, isChannel: true });
  });

  test("双向关系对不上时不采信残留别名，免得回执写成另一个人的名字", () => {
    cacheSender(userMessage(42, "Alice_1"));
    // 模拟单边残留：正向记录还指着 42，反向记录已经改名。
    senderUsernameCache.set(42, "someone_else");
    expect(resolveIdTarget(42)).toEqual({ id: 42 });
  });

  test("负数 id 落进残留别名那一档时，最小身份仍然带 isChannel", () => {
    cacheSender(senderChatMessage(-1002233445566, "Ad_Channel"));
    senderUsernameCache.set(-1002233445566, "someone_else");
    expect(resolveIdTarget(-1002233445566)).toEqual({ id: -1002233445566, isChannel: true });
  });
});
