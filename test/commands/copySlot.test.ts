import { describe, expect, test } from "bun:test";
import {
  cancelPendingCopySlot,
  cancelPendingCopySlotOwnedBy,
  claimCopySlot,
  commitCopySlot,
  releaseCopySlot,
} from "../../packages/commands/copySlot";
import type { GlobalCopyState } from "../../packages/types/chatState";

describe("copy global slot", () => {
  test("第一个跨群启动同步占位，提交前拒绝第二个启动，释放后可重新认领", () => {
    const state: GlobalCopyState = { copiedUser: null };
    const first = claimCopySlot(state, -1001);
    expect(first.claimed).toBe(true);
    expect(claimCopySlot(state, -1002)).toEqual({ claimed: false, reason: "pending" });
    if (!first.claimed) throw new Error("expected first claim");

    releaseCopySlot(first.claim);
    const second = claimCopySlot(state, -1002);
    expect(second.claimed).toBe(true);
    if (!second.claimed) throw new Error("expected second claim");
    expect(commitCopySlot(second.claim, state, {
      copiedUser: { id: 8, first_name: "Bob" },
      copyMode: "reverse",
      copyChatId: -1002,
    })).toBe(true);
    expect(state).toEqual({
      copiedUser: { id: 8, first_name: "Bob" },
      copyMode: "reverse",
      copyChatId: -1002,
    });
    expect(claimCopySlot(state, -1003)).toEqual({
      claimed: false,
      reason: "active",
      copiedUser: { id: 8, first_name: "Bob" },
    });
  });

  test("/stop_copy 取消未提交占位后，迟到的提交不能重新启动 copy", () => {
    const state: GlobalCopyState = { copiedUser: null };
    const decision = claimCopySlot(state, -1003);
    if (!decision.claimed) throw new Error("expected claim");

    expect(cancelPendingCopySlot()).toBe(true);
    expect(commitCopySlot(decision.claim, state, {
      copiedUser: { id: 9, first_name: "Carol" },
      copyMode: undefined,
      copyChatId: -1003,
    })).toBe(false);
    expect(state).toEqual({ copiedUser: null });
    expect(cancelPendingCopySlot()).toBe(false);
  });

  test("群 teardown 只取消自己持有的未提交占位", () => {
    const state: GlobalCopyState = { copiedUser: null };
    const decision = claimCopySlot(state, -1004);
    if (!decision.claimed) throw new Error("expected claim");

    expect(cancelPendingCopySlotOwnedBy(-1005)).toBe(false);
    expect(commitCopySlot(decision.claim, state, {
      copiedUser: { id: 10, first_name: "Dave" },
      copyMode: undefined,
      copyChatId: -1004,
    })).toBe(true);
  });
});
