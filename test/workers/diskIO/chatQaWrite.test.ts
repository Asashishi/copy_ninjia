import { beforeEach, describe, expect, test } from "bun:test";
import { CHAT_QA_MAX_PER_CHAT } from "../../../packages/consts/qa";
import { encodeChatQaData } from "../../../packages/database/codec/chatQa";
import { clearStorageBusinessTables } from
  "../../../scripts/fixtures/storageDatabase";
import { CHAT_QA_WRITE_BATCH_MAX_ENTRIES } from "../../../packages/consts/identityStorage";
import {
  pendingChatQaEntryCount,
  pendingChatQaWrites,
  resetStorageDatabaseCache,
} from "../../../packages/cache/workers/diskIO/storageDatabase";
import { hydrateStorageDatabase } from "../../helpers/storageDatabaseHydration";
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

/** 指定群的一条非空问答写入，供跨群累计批次阈值的用例使用。 */
function writeInChat(chatId: number, q: string, revision: number): ChatQaWriteDiskMessage {
  return { ...write(q, "答案", revision), chatId };
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
    expect(pendingChatQaWrites.has(CHAT_ID)).toBeFalse();
  });

  test("跨群累计到 CHAT_QA_WRITE_BATCH_MAX_ENTRIES 条问答变化立即提交全部待写值", () => {
    const acknowledged: unknown[] = [];
    const reply = (persisted: { chatQaWrites: readonly unknown[] }): void => {
      acknowledged.push(...persisted.chatQaWrites);
    };
    for (let index: number = 0; index < CHAT_QA_WRITE_BATCH_MAX_ENTRIES - 1; index++) {
      const chatId: number = CHAT_ID - Math.floor(index / CHAT_QA_MAX_PER_CHAT);
      handleChatQaWrite(writeInChat(chatId, `问题${index}`, index + 1), reply);
    }
    // 同一条问题的更新只覆盖最终值，不另计一条。
    handleChatQaWrite(write("问题0", "新答案", 100), reply);
    expect(pendingChatQaEntryCount.current).toBe(CHAT_QA_WRITE_BATCH_MAX_ENTRIES - 1);
    expect(acknowledged).toHaveLength(0);

    const lastChatId: number = CHAT_ID - Math.floor((CHAT_QA_WRITE_BATCH_MAX_ENTRIES - 1) / CHAT_QA_MAX_PER_CHAT);
    handleChatQaWrite(writeInChat(lastChatId, "最后一条", 200), reply);

    expect(acknowledged).toHaveLength(CHAT_QA_WRITE_BATCH_MAX_ENTRIES);
    expect(pendingChatQaWrites.size).toBe(0);
    expect(pendingChatQaEntryCount.current).toBe(0);
  });
});
