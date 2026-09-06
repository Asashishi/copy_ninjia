import { beforeEach, describe, expect, mock, test } from "bun:test";
import { CHAT_QA_MAX_PER_CHAT } from "../../packages/consts/qa";

const posted: unknown[] = [];
let persistedListener: ((reply: unknown) => void) | undefined;
let respawnListener: ((transport: unknown) => boolean) | undefined;
let postSucceeds: boolean = true;

mock.module("../../packages/infra/diskIO", () => ({
  postDiskIO: (message: unknown): boolean => {
    if (!postSucceeds) return false;
    posted.push(message);
    return true;
  },
  onIdentityStoragePersisted: (callback: (reply: unknown) => void): void => {
    persistedListener = callback;
  },
  // 按 owner 名捕获：同一 isolate 里还有别的领域也会登记重放回调。
  onDiskIORespawn: (
    owner: string,
    _priority: number,
    listener: (transport: unknown) => boolean
  ): void => {
    if (owner === "chat qa") respawnListener = listener;
  },
  // logger 静态 import 了 infra/diskIO，模块被整体替换后这个出口也得给全。
  relayLogMessage: (): boolean => true,
}));

const {
  chatQaCount,
  getChatQa,
  hydrateChatQaCache,
  removeChatQa,
  setChatQa,
} = await import("../../packages/infra/qaStore");
const { chatQaEntries, unacknowledgedChatQaWrites, resetChatQaCache } =
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

    expect(getChatQa(CHAT_ID)?.get("怎么入群？")).toBe("点置顶");
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
    expect(getChatQa(CHAT_ID)?.get("怎么入群？")).toBe("新答案");
  });

  test("撞上每群上限后新增抛错，覆盖既有条目不受影响", () => {
    for (let index: number = 0; index < CHAT_QA_MAX_PER_CHAT; index++) {
      setChatQa(CHAT_ID, `问题${index}`, `答案${index}`);
    }

    expect(() => setChatQa(CHAT_ID, "再来一条", "不行"))
      .toThrow(`at most ${CHAT_QA_MAX_PER_CHAT} entries per chat`);
    // 覆盖不占新名额，因此必须仍然放行。
    expect(setChatQa(CHAT_ID, "问题0", "改了")).toBe("replaced");
    expect(chatQaCount(CHAT_ID)).toBe(CHAT_QA_MAX_PER_CHAT);
  });

  test("删除只在真的删掉时返回 true，删空后整群从热表移除", () => {
    setChatQa(CHAT_ID, "怎么入群？", "点置顶");

    expect(removeChatQa(CHAT_ID, "不存在的")).toBeFalse();
    expect(removeChatQa(CHAT_ID, "怎么入群？")).toBeTrue();
    // 空表不留存，否则直答路径第一步的 get(chatId) 再也不能靠 undefined 短路。
    expect(chatQaEntries.has(CHAT_ID)).toBeFalse();
    expect(getChatQa(CHAT_ID)).toBeUndefined();
  });

  test("精确 ACK 只清对应 revision，迟到的 ACK 不清更新的写", () => {
    setChatQa(CHAT_ID, "怎么入群？", "点置顶");
    const first: number = unacknowledgedChatQaWrites.get(CHAT_ID)!.get("怎么入群？")!;
    setChatQa(CHAT_ID, "怎么入群？", "改了");

    persistedListener?.({
      writes: [],
      chatStateWrites: [],
      chatQaWrites: [{ chatId: CHAT_ID, q: "怎么入群？", revision: first }],
    });

    // 迟到的 ACK 对应的是已经被更新值取代的那一版，不能把未确认记录清掉。
    expect(unacknowledgedChatQaWrites.get(CHAT_ID)?.get("怎么入群？")).toBe(first + 1);
  });

  test("Worker 重建后按内存最终值重放未确认写", () => {
    setChatQa(CHAT_ID, "怎么入群？", "点置顶");
    posted.length = 0;
    const replayed: unknown[] = [];

    expect(respawnListener?.({ post: (m: unknown): boolean => {
      replayed.push(m);
      return true;
    } })).toBeTrue();
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({ type: "chatQaWrite", chatId: CHAT_ID });
  });

  test("投递失败仍保留未确认 revision，等重建重放", () => {
    postSucceeds = false;

    expect((): unknown => setChatQa(CHAT_ID, "怎么入群？", "点置顶")).toThrow("persistence");

    expect(unacknowledgedChatQaWrites.get(CHAT_ID)?.has("怎么入群？")).toBeTrue();
    expect(getChatQa(CHAT_ID)?.get("怎么入群？")).toBe("点置顶");
  });

  test("hydrate 只搬持久化值，空群不进热表", () => {
    hydrateChatQaCache(new Map([
      [CHAT_ID, new Map([["怎么入群？", "点置顶"]])],
      [-1002, new Map()],
    ]));

    expect(getChatQa(CHAT_ID)?.get("怎么入群？")).toBe("点置顶");
    expect(getChatQa(-1002)).toBeUndefined();
  });
});
