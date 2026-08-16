import { describe, expect, test } from "bun:test";
import { decodePendingBlockedRemovalData } from "../../packages/database/codec/identity";
import type { PendingBlockedRemoval } from "../../packages/types/blocklist";

function pendingRemovalJson(chatId: number): string {
  return JSON.stringify({
    params: {
      chatId,
      probeMembership: true,
      removalId: 1,
    },
    createdAt: 1_000,
    attempts: 0,
    lastFailure: null,
  });
}

describe("identity codec", () => {
  test("待踢 outbox 的 chatId 只接受 Telegram 群或频道负 ID", () => {
    const decoded: PendingBlockedRemoval = decodePendingBlockedRemovalData(
      pendingRemovalJson(-1001),
      "pending_blocked_removals[1].data"
    );
    expect(decoded.params.chatId).toBe(-1001);

    expect((): PendingBlockedRemoval => decodePendingBlockedRemovalData(
      pendingRemovalJson(1001),
      "pending_blocked_removals[1].data"
    )).toThrow("$.params.chatId");
    expect((): PendingBlockedRemoval => decodePendingBlockedRemovalData(
      pendingRemovalJson(0),
      "pending_blocked_removals[1].data"
    )).toThrow("$.params.chatId");
  });
});
