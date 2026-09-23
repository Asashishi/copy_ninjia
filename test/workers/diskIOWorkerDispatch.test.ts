/**
 * Disk I/O Worker 路由层里此前没有任何用例走过的五条分支：删掉其中任意一条
 * `case` 都必须让本文件变红。夹具与 diskIOWorker.test.ts 共用，见
 * test/helpers/diskIOWorkerRouterHarness.ts。
 */

import { describe, expect, test } from "bun:test";
import {
  handleJoinLogDeleteMessage,
  handleVerificationUpsert,
  postMessage,
  route,
} from "../helpers/diskIOWorkerRouterHarness";
import { aiMemoryOperations, aiMemoryRevisions } from
  "../../packages/cache/workers/diskIO/snapshots";
import type { VerificationSnapshot } from "../../packages/types/antiRaid/verification";

const CHAT_ID: number = -1_001;

function snapshot(userId: number): VerificationSnapshot {
  return {
    chatId: CHAT_ID,
    userId,
    generation: 1,
    revision: 1,
    label: `@u${userId}`,
    isBot: false,
    trackedMessageTimes: [],
    replyReminderRequested: false,
    reminderSuperseded: false,
    joinedAt: 1_000,
    expiresAt: 2_000,
    phase: "pending",
  };
}

describe("Disk I/O Worker 路由：此前无用例覆盖的分支", () => {
  test("forgetAiMemory 同步丢掉该群的 revision 水位线", async () => {
    aiMemoryRevisions.set(CHAT_ID, 9);
    aiMemoryOperations.set(CHAT_ID, "delete");
    aiMemoryRevisions.set(-1_002, 3);

    await route({ type: "forgetAiMemory", chatId: CHAT_ID });

    expect(aiMemoryRevisions.has(CHAT_ID)).toBeFalse();
    expect(aiMemoryOperations.has(CHAT_ID)).toBeFalse();
    // 只丢被点名的那个群。
    expect(aiMemoryRevisions.get(-1_002)).toBe(3);
    aiMemoryRevisions.clear();
    aiMemoryOperations.clear();
  });

  test("verificationUpsert 交给待验证写入 owner，并带上回执通道", async () => {
    const record: VerificationSnapshot = snapshot(42);

    await route({ type: "verificationUpsert", record, critical: true });

    expect(handleVerificationUpsert).toHaveBeenCalledTimes(1);
    const input = handleVerificationUpsert.mock.calls[0]?.[0] as {
      msg: { type: string; record: VerificationSnapshot; critical: boolean };
      reply: (value: unknown) => void;
    };
    expect(input.msg).toEqual({ type: "verificationUpsert", record, critical: true });
    // 回执必须原样回到 Worker 全局的 postMessage，而不是被路由层吞掉。
    input.reply({ type: "verificationPersisted", chatId: CHAT_ID, userId: 42, generation: 1, revision: 1 });
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "verificationPersisted", chatId: CHAT_ID, userId: 42, generation: 1, revision: 1,
    });
  });

  test("deleteJoinLog 交给入群日志 owner 整群删除", async () => {
    await route({ type: "deleteJoinLog", chatId: CHAT_ID });

    expect(handleJoinLogDeleteMessage).toHaveBeenCalledTimes(1);
    expect(handleJoinLogDeleteMessage.mock.calls[0]?.[0])
      .toEqual({ type: "deleteJoinLog", chatId: CHAT_ID });
  });

  test("readIdentityPolicies 的回执原样投回主线程", async () => {
    await route({ type: "readIdentityPolicies", requestId: 11, ids: [7, 8] });

    expect(postMessage).toHaveBeenLastCalledWith({
      type: "identityPoliciesRead",
      requestId: 11,
      whitelist: [],
      blocklist: [],
      temporaryAdBypass: [],
    });
  });

  test("readBlocklistIdPage 的回执原样投回主线程", async () => {
    await route({ type: "readBlocklistIdPage", requestId: 12, afterId: 99 });

    expect(postMessage).toHaveBeenLastCalledWith({
      type: "blocklistIdPageRead",
      requestId: 12,
      page: { ids: [], nextCursor: 99, done: true },
    });
  });
});
