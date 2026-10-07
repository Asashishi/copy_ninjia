import type { DiskIORespawnListener } from "../../packages/types/diskIO/messages";
import type { IdentityStoragePersistedReply } from "../../packages/types/diskIO/replies";
import { diskIOReplyStub, diskIOStub } from "../helpers/diskIOMock";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { CHAT_QA_MAX_PER_CHAT } from "../../packages/consts/qa";

const posted: unknown[] = [];
let persistedListener: ((reply: IdentityStoragePersistedReply) => void) | undefined;
let respawnListener: (DiskIORespawnListener) | undefined;
let postSucceeds: boolean = true;

mock.module("../../packages/infra/diskIO", () => (diskIOStub({
  postDiskIO: (message: unknown): boolean => {
    if (!postSucceeds) return false;
    posted.push(message);
    return true;
  },
  onDiskIOReply: diskIOReplyStub({
    identityStoragePersisted: (callback: (reply: IdentityStoragePersistedReply) => void): void => {
      persistedListener = callback;
    },
  }),
  // 按 owner 名捕获：同一 isolate 里还有别的领域也会登记重放回调。
  onDiskIORespawn: (
    owner: string,
    _priority: number,
    listener: DiskIORespawnListener
  ): void => {
    if (owner === "chat qa") respawnListener = listener;
  },
  // logger 静态 import 了 infra/diskIO，模块被整体替换后这个出口也得给全。
  relayLogMessage: (): boolean => true,
})));

const {
  hydrateChatQaCache,
  removeAllChatQa,
  removeChatQa,
  setChatQa,
} = await import("../../packages/infra/qaStore");
const { chatQaEntries, unacknowledgedChatQaTotals, unacknowledgedChatQaWrites, resetChatQaCache } =
  await import("../../packages/cache/main/qa");

const CHAT_ID: number = -1001;

beforeEach((): void => {
  posted.length = 0;
  postSucceeds = true;
  resetChatQaCache();
});

describe("群问答主线程持久化边界", () => {
  test("写入先发布内存最终值，再排一条 SQLite 写", () => {
    expect(setChatQa(CHAT_ID, "怎么入群？", "点置顶")).toBe("created");

    expect(chatQaEntries.get(CHAT_ID)?.get("怎么入群？")).toBe("点置顶");
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      type: "chatQaWrite",
      chatId: CHAT_ID,
      q: "怎么入群？",
      revision: 2,
    });
  });

  test("同一问题再写返回 replaced，回执据此措辞", () => {
    setChatQa(CHAT_ID, "怎么入群？", "旧答案");

    expect(setChatQa(CHAT_ID, "怎么入群？", "新答案")).toBe("replaced");
    expect(chatQaEntries.get(CHAT_ID)?.get("怎么入群？")).toBe("新答案");
  });

  test("撞上每群上限后新增抛错，覆盖既有条目不受影响", () => {
    for (let index: number = 0; index < CHAT_QA_MAX_PER_CHAT; index++) {
      setChatQa(CHAT_ID, `问题${index}`, `答案${index}`);
    }

    expect(() => setChatQa(CHAT_ID, "再来一条", "不行"))
      .toThrow(`at most ${CHAT_QA_MAX_PER_CHAT} entries per chat`);
    // 覆盖不占新名额，放行。
    expect(setChatQa(CHAT_ID, "问题0", "改了")).toBe("replaced");
    expect((chatQaEntries.get(CHAT_ID)?.size ?? 0)).toBe(CHAT_QA_MAX_PER_CHAT);
  });

  test("删除只在真的删掉时返回 true，删空后整群从热表移除", () => {
    setChatQa(CHAT_ID, "怎么入群？", "点置顶");

    expect(removeChatQa(CHAT_ID, "不存在的")).toBeFalse();
    expect(removeChatQa(CHAT_ID, "怎么入群？")).toBeTrue();
    // 空表不留存，直答路径第一步的 get(chatId) 靠 undefined 短路。
    expect(chatQaEntries.has(CHAT_ID)).toBeFalse();
    expect(chatQaEntries.get(CHAT_ID)).toBeUndefined();
  });

  test("整群删除逐条发墓碑并把该群从热表移除；没登记过的群零投递", () => {
    setChatQa(CHAT_ID, "怎么入群？", "点置顶");
    setChatQa(CHAT_ID, "在哪充值？", "不充");
    setChatQa(-2002, "别的群？", "不动它");
    posted.length = 0;

    expect(removeAllChatQa(CHAT_ID)).toBe(2);

    expect(posted).toHaveLength(2);
    for (const message of posted) {
      expect(message).toMatchObject({ type: "chatQaWrite", chatId: CHAT_ID, data: null });
    }
    expect(chatQaEntries.has(CHAT_ID)).toBeFalse();
    expect(chatQaEntries.get(CHAT_ID)).toBeUndefined();
    // 只删这一个群。
    expect(chatQaEntries.get(-2002)?.get("别的群？")).toBe("不动它");

    posted.length = 0;
    expect(removeAllChatQa(CHAT_ID)).toBe(0);
    expect(posted).toHaveLength(0);
  });

  test("精确 ACK 只清对应 revision，迟到的 ACK 不清更新的写", () => {
    setChatQa(CHAT_ID, "怎么入群？", "点置顶");
    const first: number = unacknowledgedChatQaWrites.get(CHAT_ID)!.get("怎么入群？")!.revision;
    setChatQa(CHAT_ID, "怎么入群？", "改了");

    persistedListener?.({
      type: "identityStoragePersisted",
      temporaryAdBypassWrites: [],
      writes: [],
      chatStateWrites: [],
      chatQaWrites: [{ chatId: CHAT_ID, q: "怎么入群？", revision: first }],
    });

    // 迟到的 ACK 对应的是已被更新值取代的那一版，不清未确认记录。
    expect(unacknowledgedChatQaWrites.get(CHAT_ID)?.get("怎么入群？")?.revision).toBe(first + 1);
    // 总账只记最新那一版：同一问题覆盖不重复计条数，字节按差额更新。
    expect(unacknowledgedChatQaTotals).toEqual({
      entries: 1,
      bytes: unacknowledgedChatQaWrites.get(CHAT_ID)!.get("怎么入群？")!.bytes,
    });

    persistedListener?.({
      type: "identityStoragePersisted",
      temporaryAdBypassWrites: [],
      writes: [],
      chatStateWrites: [],
      chatQaWrites: [{ chatId: CHAT_ID, q: "怎么入群？", revision: first + 1 }],
    });
    expect(unacknowledgedChatQaWrites.has(CHAT_ID)).toBeFalse();
    expect(unacknowledgedChatQaTotals).toEqual({ entries: 0, bytes: 0 });
  });

  test("Worker 重建后按内存最终值重放未确认写", () => {
    setChatQa(CHAT_ID, "怎么入群？", "点置顶");
    posted.length = 0;
    const replayed: unknown[] = [];

    expect(respawnListener?.({ ensureLuckReceiptSecret: async (): Promise<never> => { throw new Error("Unexpected secret request."); }, post: (m: unknown): boolean => {
      replayed.push(m);
      return true;
    } })).toBeTrue();
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({ type: "chatQaWrite", chatId: CHAT_ID });
  });

  test("发布后投递失败不抛错：改动已生效，未确认 revision 留给重建重放", () => {
    postSucceeds = false;

    expect(setChatQa(CHAT_ID, "怎么入群？", "点置顶")).toBe("created");

    expect(unacknowledgedChatQaWrites.get(CHAT_ID)?.has("怎么入群？")).toBeTrue();
    expect(chatQaEntries.get(CHAT_ID)?.get("怎么入群？")).toBe("点置顶");
  });

  test("整群删除遇到投递失败不中途打断，每条都摘除并留待重放", () => {
    setChatQa(CHAT_ID, "问题一", "答案一");
    setChatQa(CHAT_ID, "问题二", "答案二");
    postSucceeds = false;

    expect(removeAllChatQa(CHAT_ID)).toBe(2);

    expect(chatQaEntries.has(CHAT_ID)).toBeFalse();
    expect(unacknowledgedChatQaWrites.get(CHAT_ID)?.size).toBe(2);
  });

  test("hydrate 只搬持久化值，空群不进热表", () => {
    hydrateChatQaCache(new Map([
      [CHAT_ID, new Map([["怎么入群？", "点置顶"]])],
      [-1002, new Map()],
    ]));

    expect(chatQaEntries.get(CHAT_ID)?.get("怎么入群？")).toBe("点置顶");
    expect(chatQaEntries.get(-1002)).toBeUndefined();
  });
});
