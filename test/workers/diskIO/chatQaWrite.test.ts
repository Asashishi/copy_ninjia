import { beforeEach, describe, expect, test } from "bun:test";
import { CHAT_QA_MAX_PER_CHAT } from "../../../packages/consts/qa";
import { encodeChatQaData } from "../../../packages/database/codec/chatQa";
import { clearStorageBusinessTables } from
  "../../../packages/database/interact/admin";
import {
  pendingChatQaWrites,
  resetStorageDatabaseCache,
} from "../../../packages/cache/workers/diskIO/storageDatabase";
import { hydrateStorageDatabase } from
  "../../../packages/workers/diskIO/storageDatabase/hydration";
import { handleChatQaWrite } from
  "../../../packages/workers/diskIO/storageDatabase/chatQa";
import { flushStorageDatabase } from
  "../../../packages/workers/diskIO/storageDatabase/flush";
import { requireStorageDatabase } from
  "../../../packages/workers/diskIO/storageDatabase/context";
import type { ChatQaWriteDiskMessage } from "../../../packages/types/diskIO";

const CHAT_ID: number = -1001;
const SOURCE: string = "test";
const noReply: () => void = (): void => {};

function write(q: string, answer: string | null, revision: number): ChatQaWriteDiskMessage {
  return {
    type: "chatQaWrite",
    chatId: CHAT_ID,
    q,
    data: answer === null ? null : encodeChatQaData(answer, SOURCE),
    revision,
  };
}

beforeEach((): void => {
  resetStorageDatabaseCache();
  hydrateStorageDatabase();
  clearStorageBusinessTables(requireStorageDatabase());
});

describe("Disk I/O Worker 的问答写入闸", () => {
  test("收下最终值并按 (群, 问题) 进缓冲", () => {
    handleChatQaWrite(write("怎么入群？", "点置顶", 1), noReply);

    expect(pendingChatQaWrites.get(CHAT_ID)?.get("怎么入群？")).toMatchObject({ revision: 1 });
  });

  test("迟到的写不得覆盖更新的最终值", () => {
    handleChatQaWrite(write("怎么入群？", "新答案", 5), noReply);
    handleChatQaWrite(write("怎么入群？", "旧答案", 3), noReply);

    expect(pendingChatQaWrites.get(CHAT_ID)?.get("怎么入群？")?.revision).toBe(5);
  });

  test("每群条数上限在进事务缓冲之前就拒绝", () => {
    for (let index: number = 0; index < CHAT_QA_MAX_PER_CHAT; index++) {
      handleChatQaWrite(write(`问题${index}`, "答案", index + 1), noReply);
    }

    expect(() => handleChatQaWrite(write("再来一条", "不行", 99), noReply))
      .toThrow(`at most ${CHAT_QA_MAX_PER_CHAT} entries per chat`);
    // 被拒的那条不得留在缓冲里。
    expect(pendingChatQaWrites.get(CHAT_ID)?.has("再来一条")).toBeFalse();
  });

  test("删除写不占容量，因此满表时仍可先删再加", () => {
    for (let index: number = 0; index < CHAT_QA_MAX_PER_CHAT; index++) {
      handleChatQaWrite(write(`问题${index}`, "答案", index + 1), noReply);
    }

    expect(() => handleChatQaWrite(write("问题0", null, 10), noReply)).not.toThrow();
    expect(() => handleChatQaWrite(write("新问题", "新答案", 11), noReply)).not.toThrow();
  });

  test("非法问题、非法答案与非法 revision 一律拒绝", () => {
    expect(() => handleChatQaWrite(write(" 前导空白", "x", 1), noReply)).toThrow();
    expect(() => handleChatQaWrite(
      { type: "chatQaWrite", chatId: CHAT_ID, q: "a", data: "not json", revision: 1 },
      noReply
    )).toThrow();
    expect(() => handleChatQaWrite(write("a", "x", 0), noReply)).toThrow("positive safe integer");
  });

  test("提交后缓冲清空，且 ACK 里带 (群, 问题, revision)", () => {
    handleChatQaWrite(write("怎么入群？", "点置顶", 1), noReply);
    const acknowledged: unknown[] = [];

    flushStorageDatabase((reply): void => {
      acknowledged.push(...reply.chatQaWrites);
    });

    expect(acknowledged).toEqual([{ chatId: CHAT_ID, q: "怎么入群？", revision: 1 }]);
    // 空 Map 不留存，否则每个曾写过问答的群都会在缓冲里留一项空壳。
    expect(pendingChatQaWrites.has(CHAT_ID)).toBeFalse();
  });
});
