import { afterEach, describe, expect, test } from "bun:test";
import type { CachedUser, GlobalCopyState } from "../../packages/types/chatState";

/**
 * `/copy` 的群 teardown：只停止由被拆除群持有的全局复读，走真实 stateStore 的
 * 三元组写入与清空边界，不替身 clearCopyTarget。
 */

await import("../../packages/commands/copy");
const { teardownRegisteredChat } = await import("../../packages/infra/chatTeardownRegistry");
const {
  adoptCopyTarget,
  clearCopyTarget,
  getGlobalCopyState,
} = await import("../../packages/infra/storage/stateStore");

const TARGET: CachedUser = { id: 42, first_name: "Target" };

afterEach(() => {
  clearCopyTarget();
});

describe("copy 的群 teardown", () => {
  test("拆除持有复读的群时整组清空复读目标，冷却记账保持原值", async () => {
    adoptCopyTarget(TARGET, "nya", -1001);
    const state: GlobalCopyState = getGlobalCopyState();
    state.lastCopyTime = 1_234;

    await teardownRegisteredChat("copy", -1001, "explicitDisable");

    expect(state.copiedUser).toBeNull();
    expect(state.copyMode).toBeUndefined();
    expect(state.copyChatId).toBeUndefined();
    expect(state.lastCopyTime).toBe(1_234);
  });

  test("拆除别的群或没有复读时不改动全局复读", async () => {
    adoptCopyTarget(TARGET, "reverse", -1001);

    for (const reason of ["explicitDisable", "departed", "lostAuthority"] as const) {
      await teardownRegisteredChat("copy", -2002, reason);
    }

    expect(getGlobalCopyState()).toMatchObject({ copiedUser: TARGET, copyMode: "reverse", copyChatId: -1001 });
    clearCopyTarget();
    await teardownRegisteredChat("copy", -1001, "departed");
    expect(getGlobalCopyState().copiedUser).toBeNull();
  });
});
