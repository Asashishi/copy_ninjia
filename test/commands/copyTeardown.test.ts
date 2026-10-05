import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CachedUser, GlobalCopyState, GlobalState } from "../../packages/types/chatState";
import type { AvatarUpdateRequest } from "../../packages/types/copy/avatar";

/**
 * `/copy` 的群 teardown：只停止由被拆除群持有的全局复读，走真实 stateStore 的
 * 三元组写入、清空与落盘边界，不替身 clearCopyTarget；头像队列替身只记录提交。
 */

const queueAvatarUpdate = mock((_request: AvatarUpdateRequest): void => {});
mock.module("../../packages/copy/avatarQueue", () => ({ queueAvatarUpdate }));

await import("../../packages/commands/copy");
const { teardownRegisteredChat } = await import("../../packages/infra/chatTeardownRegistry");
const {
  StateStore,
  adoptCopyTarget,
  clearCopyTarget,
  getGlobalCopyState,
} = await import("../../packages/infra/storage/stateStore");
const { stateStoreHolder } = await import("../../packages/cache/main/storage");

const TARGET: CachedUser = { id: 42, first_name: "Target" };

let dir: string = "";
let statePath: string = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "copy-teardown-test-"));
  statePath = join(dir, "state.json");
  stateStoreHolder.current = new StateStore({ stateFilePath: statePath });
  queueAvatarUpdate.mockClear();
});

afterEach(async () => {
  clearCopyTarget();
  await stateStoreHolder.current?.flush(1_000, true);
  stateStoreHolder.current = null;
  rmSync(dir, { recursive: true, force: true });
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

  test("三种起因都在返回前把清空后的复读状态落盘，再静默复原默认头像", async () => {
    for (const reason of ["explicitDisable", "departed", "lostAuthority"] as const) {
      adoptCopyTarget(TARGET, "reverse", -1001);
      queueAvatarUpdate.mockClear();

      await teardownRegisteredChat("copy", -1001, reason);

      const written: GlobalState = JSON.parse(await Bun.file(statePath).text()) as GlobalState;
      expect(written.copy.copiedUser).toBeNull();
      expect(queueAvatarUpdate.mock.calls).toEqual([[
        { chatId: -1001, target: { kind: "default" }, source: "copy", silent: true },
      ]]);
    }
  });

  test("拆除别的群或没有复读时不改动全局复读，也不复原头像", async () => {
    adoptCopyTarget(TARGET, "reverse", -1001);

    for (const reason of ["explicitDisable", "departed", "lostAuthority"] as const) {
      await teardownRegisteredChat("copy", -2002, reason);
    }

    expect(getGlobalCopyState()).toMatchObject({ copiedUser: TARGET, copyMode: "reverse", copyChatId: -1001 });
    clearCopyTarget();
    await teardownRegisteredChat("copy", -1001, "departed");
    expect(getGlobalCopyState().copiedUser).toBeNull();
    expect(queueAvatarUpdate).not.toHaveBeenCalled();
  });
});
