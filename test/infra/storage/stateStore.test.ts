import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  StateStore,
  getActiveProxySendTarget,
  pruneDepartedChatState,
} from "../../../packages/infra/storage/stateStore";
import { chatStates } from "../../../packages/cache/main/storage";
import type { LockdownRecord, StateFileSchema } from "../../../packages/types/chatState";

function schema(chatId: number): StateFileSchema {
  return {
    chats: { [String(chatId)]: { isAIChatEnabled: true } },
    globalCopy: { copiedUser: null },
  };
}

describe("StateStore", () => {
  test("拒绝非法重试延时与 flush 预算", () => {
    expect(() => new StateStore({ retryDelaysMs: [] })).toThrow("at least one retry delay");
    expect(() => new StateStore({ retryDelaysMs: [0] })).toThrow("positive finite");
    const store = new StateStore();
    expect(() => store.flush(0)).toThrow("positive finite");
    expect(() => store.flush(Number.NaN)).toThrow("positive finite");
    store.dispose();
  });

  test("注入 IO 后独立验证 schema 序列化与 latest-only 写入", async () => {
    const writes: { path: string; content: string }[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const store = new StateStore({
      stateFilePath: "/virtual/state.json",
      writeText: async (path, content) => {
        writes.push({ path, content });
        if (writes.length === 1) await firstBlocked;
      },
    });

    const first = store.save(schema(1));
    const second = store.save(schema(2));
    const third = store.save(schema(3));
    releaseFirst!();
    await Promise.allSettled([first, second, third]);

    expect(writes.map((write) => write.path)).toEqual([
      "/virtual/state.json",
      "/virtual/state.json.bak",
      "/virtual/state.json",
      "/virtual/state.json.bak",
    ]);
    expect(JSON.parse(writes[3]!.content)).toEqual(schema(3));
    store.dispose();
  });

  test("失败快照由退避计时器重试，成功后不依赖模块级全局状态", async () => {
    let attempts: number = 0;
    let retried: (() => void) | undefined;
    const retryCompleted = new Promise<void>((resolve) => {
      retried = resolve;
    });
    const store = new StateStore({
      retryDelaysMs: [1],
      writeText: async () => {
        attempts++;
        if (attempts === 1) throw new Error("disk unavailable");
        retried!();
      },
    });

    const saved: Promise<void> = store.save(schema(4));
    await retryCompleted;
    await expect(saved).resolves.toBeUndefined();
    expect(attempts).toBe(3);
    await store.flush(20);
    store.dispose();
  });

  test("后台快照只排队重试，不为永久磁盘故障保留逐次持久化等待者", async () => {
    let attempts: number = 0;
    const store = new StateStore({
      retryDelaysMs: [1],
      writeText: async () => {
        attempts++;
        throw new Error("disk unavailable");
      },
    });

    await expect(store.save(schema(40), { waitForPersistence: false })).resolves.toBeUndefined();
    await Bun.sleep(5);
    expect(attempts).toBeGreaterThan(1);
    await expect(store.flush(20, true)).resolves.toBe("failed");
    store.dispose();
  });

  test("权威写入用尽有限重试后 reject 等待者并只触发一次 fatal", async () => {
    const fatalErrors: Error[] = [];
    let attempts: number = 0;
    const store = new StateStore({
      retryDelaysMs: [1],
      maxAttempts: 2,
      onRetryError: () => {},
      onFatal: (error) => { fatalErrors.push(error); },
      writeText: async () => {
        attempts++;
        throw new Error("read-only filesystem");
      },
    });

    await expect(store.save(schema(41))).rejects.toThrow("refusing further updates");
    expect(attempts).toBe(2);
    expect(fatalErrors).toHaveLength(1);
    await expect(store.save(schema(42))).rejects.toThrow("quiescing");
    expect(fatalErrors).toHaveLength(1);
    store.dispose();
  });

  test("load 通过当前严格 codec 解码，不存在文件返回 null", async () => {
    const missing = new StateStore({ readText: async () => null });
    await expect(missing.load()).resolves.toBeNull();

    const expected = schema(5);
    const existing = new StateStore({ readText: async () => JSON.stringify(expected) });
    await expect(existing.load()).resolves.toEqual(expected);
    missing.dispose();
    existing.dispose();
  });

  test("主文件有效但备份缺失时先补建 LKG，再返回解码状态", async () => {
    const expected: StateFileSchema = schema(50);
    const primaryContent: string = JSON.stringify(expected, null, 2);
    const writes: { path: string; content: string }[] = [];
    const store = new StateStore({
      stateFilePath: "/virtual/state.json",
      readText: async (path) => path.endsWith(".bak") ? null : primaryContent,
      writeText: async (path, content) => { writes.push({ path, content }); },
    });

    await expect(store.load()).resolves.toEqual(expected);
    expect(writes).toEqual([{ path: "/virtual/state.json.bak", content: primaryContent }]);
    store.dispose();
  });

  test("主文件有效时直接刷新内容不同但同样合法的旧备份", async () => {
    const primary: string = JSON.stringify(schema(51), null, 2);
    const staleBackup: string = JSON.stringify(schema(52), null, 2);
    const writes: { path: string; content: string }[] = [];
    const moves: string[] = [];
    const store = new StateStore({
      stateFilePath: "/virtual/state.json",
      readText: async (path) => path.endsWith(".bak") ? staleBackup : primary,
      writeText: async (path, content) => { writes.push({ path, content }); },
      moveFile: async (path) => { moves.push(path); },
    });

    await expect(store.load()).resolves.toEqual(schema(51));
    expect(writes).toEqual([{ path: "/virtual/state.json.bak", content: primary }]);
    expect(moves).toEqual([]);
    store.dispose();
  });

  test("主文件有效、备份损坏时隔离坏备份并重建", async () => {
    const primary: string = JSON.stringify(schema(53), null, 2);
    const moves: { source: string; destination: string }[] = [];
    const writes: { path: string; content: string }[] = [];
    const store = new StateStore({
      stateFilePath: "/virtual/state.json",
      readText: async (path) => path.endsWith(".bak") ? "{broken" : primary,
      writeText: async (path, content) => { writes.push({ path, content }); },
      moveFile: async (source, destination) => { moves.push({ source, destination }); },
    });

    await expect(store.load()).resolves.toEqual(schema(53));
    expect(moves).toHaveLength(1);
    expect(moves[0]!.source).toBe("/virtual/state.json.bak");
    expect(moves[0]!.destination).toMatch(/^\/virtual\/state\.json\.bak\.\d+\.[^.]+\.corrupt$/);
    expect(writes).toEqual([{ path: "/virtual/state.json.bak", content: primary }]);
    store.dispose();
  });

  test("主文件损坏时隔离原件，并从有效 LKG 恢复包含 lockdown 的状态", async () => {
    const expected: StateFileSchema = {
      chats: {
        "-100": {
          lockdown: {
            phase: "active",
            intentId: 9,
            originalPermissions: { can_invite_users: true, can_send_messages: false },
            expiresAt: 1_900_000_000_000,
          },
        },
      },
      globalCopy: { copiedUser: null },
    };
    const backup: string = JSON.stringify(expected, null, 2);
    const moves: { source: string; destination: string }[] = [];
    const writes: { path: string; content: string }[] = [];
    const store = new StateStore({
      stateFilePath: "/virtual/state.json",
      readText: async (path) => path.endsWith(".bak") ? backup : "{broken",
      writeText: async (path, content) => { writes.push({ path, content }); },
      moveFile: async (source, destination) => { moves.push({ source, destination }); },
    });

    await expect(store.load()).resolves.toEqual(expected);
    expect(moves).toHaveLength(1);
    expect(moves[0]!.source).toBe("/virtual/state.json");
    expect(moves[0]!.destination).toMatch(/^\/virtual\/state\.json\.\d+\.[^.]+\.corrupt$/);
    expect(writes).toEqual([{ path: "/virtual/state.json", content: backup }]);
    store.dispose();
  });

  test("主文件缺失时从有效 LKG 原子恢复且不创建损坏隔离件", async () => {
    const expected: StateFileSchema = schema(54);
    const backup: string = JSON.stringify(expected, null, 2);
    const moves: string[] = [];
    const writes: { path: string; content: string }[] = [];
    const store = new StateStore({
      stateFilePath: "/virtual/state.json",
      readText: async (path) => path.endsWith(".bak") ? backup : null,
      writeText: async (path, content) => { writes.push({ path, content }); },
      moveFile: async (source) => { moves.push(source); },
    });

    await expect(store.load()).resolves.toEqual(expected);
    expect(moves).toEqual([]);
    expect(writes).toEqual([{ path: "/virtual/state.json", content: backup }]);
    store.dispose();
  });

  test("主备均无有效状态时 fail-closed，且不隔离、不覆盖现场", async () => {
    const moves: string[] = [];
    const writes: string[] = [];
    const store = new StateStore({
      stateFilePath: "/virtual/state.json",
      readText: async (path) => path.endsWith(".bak") ? JSON.stringify({ chats: {} }) : "{broken",
      writeText: async (path) => { writes.push(path); },
      moveFile: async (source) => { moves.push(source); },
    });

    await expect(store.load()).rejects.toThrow("manual recovery is required");
    expect(moves).toEqual([]);
    expect(writes).toEqual([]);
    store.dispose();
  });

  test("隔离或恢复 IO 失败都会终止加载，不返回未建立冗余的状态", async () => {
    const backup: string = JSON.stringify(schema(55));
    const quarantineFailure = new StateStore({
      stateFilePath: "/virtual/state.json",
      readText: async (path) => path.endsWith(".bak") ? backup : "{broken",
      moveFile: async () => { throw new Error("rename unavailable"); },
    });
    await expect(quarantineFailure.load()).rejects.toThrow("rename unavailable");

    const restoreFailure = new StateStore({
      stateFilePath: "/virtual/state.json",
      readText: async (path) => path.endsWith(".bak") ? backup : null,
      writeText: async () => { throw new Error("write unavailable"); },
    });
    await expect(restoreFailure.load()).rejects.toThrow("write unavailable");
    quarantineFailure.dispose();
    restoreFailure.dispose();
  });

  test("备份写失败也算保存失败，并按主文件到备份的完整顺序重试", async () => {
    const paths: string[] = [];
    let backupAttempts: number = 0;
    const store = new StateStore({
      stateFilePath: "/virtual/state.json",
      retryDelaysMs: [1],
      writeText: async (path) => {
        paths.push(path);
        if (path.endsWith(".bak") && ++backupAttempts === 1) throw new Error("backup unavailable");
      },
    });

    await expect(store.save(schema(56))).resolves.toBeUndefined();
    expect(paths).toEqual([
      "/virtual/state.json",
      "/virtual/state.json.bak",
      "/virtual/state.json",
      "/virtual/state.json.bak",
    ]);
    store.dispose();
  });

  test("保存前拒绝严格 codec 无法重新加载的快照，主备均不写入", async () => {
    const paths: string[] = [];
    const store = new StateStore({
      writeText: async (path) => { paths.push(path); },
    });
    const invalid = {
      chats: {},
      globalCopy: { copiedUser: null },
      unknownField: true,
    } as unknown as StateFileSchema;

    await expect(store.save(invalid)).rejects.toThrow("unknownField");
    expect(paths).toEqual([]);
    store.dispose();
  });

  test("真实文件边界会持久隔离坏主文件并原子恢复 LKG", async () => {
    const dir: string = mkdtempSync(join(tmpdir(), "state-lkg-test-"));
    const statePath: string = join(dir, "state.json");
    const backupPath: string = `${statePath}.bak`;
    const backup: string = JSON.stringify(schema(57), null, 2);
    writeFileSync(statePath, "{broken");
    writeFileSync(backupPath, backup);
    const store = new StateStore({ stateFilePath: statePath });

    try {
      await expect(store.load()).resolves.toEqual(schema(57));
      expect(readFileSync(statePath, "utf8")).toBe(backup);
      const corruptEntry: string | undefined = readdirSync(dir)
        .find((entry) => /^state\.json\.\d+\.[^.]+\.corrupt$/.test(entry));
      expect(corruptEntry).toBeDefined();
      expect(readFileSync(join(dir, corruptEntry!), "utf8")).toBe("{broken");
    } finally {
      store.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("底层 writer 未停稳时 flush 明确返回 timedOut", async () => {
    const store = new StateStore({
      writeText: async () => await new Promise<void>(() => {}),
    });
    const save = store.save(schema(6)).catch(() => undefined);

    await expect(store.flush(1)).resolves.toBe("timedOut");
    store.dispose();
    await save;
  });

  test("退出 quiesce 后失败 writer 不会重新安排后台重试", async () => {
    let attempts: number = 0;
    const store = new StateStore({
      retryDelaysMs: [1],
      writeText: async () => {
        attempts++;
        throw new Error("disk unavailable");
      },
    });
    const save = store.save(schema(7)).catch(() => undefined);

    await expect(store.flush(20, true)).resolves.toBe("failed");
    const attemptsAfterFlush: number = attempts;
    await Bun.sleep(10);

    expect(attemptsAfterFlush).toBeGreaterThan(0);
    expect(attempts).toBe(attemptsAfterFlush);
    store.dispose();
    await save;
  });
});

/**
 * 内存镜像上的纯查询/裁剪门面。业务侧测试普遍 mock 掉这些函数，这里直接打
 * 真实现，避免各处替身与真语义悄悄漂移。
 */
describe("群级状态门面", () => {
  afterEach(() => {
    chatStates.clear();
  });

  test("退群清理普通配置，但保留尚需恢复的 lockdown 记录", () => {
    const lockdown: LockdownRecord = {
      phase: "active",
      intentId: 3,
      originalPermissions: { can_invite_users: true },
      expiresAt: 1_700_000_000_000,
    };
    chatStates.set(-1001, { isAIChatEnabled: true, botIsAdmin: true });
    chatStates.set(-1002, { isAIChatEnabled: true, botIsAdmin: true, lockdown });

    pruneDepartedChatState(-1001);
    pruneDepartedChatState(-1002);
    // 没有任何记录的群不应被凭空建出条目。
    pruneDepartedChatState(-1003);

    expect(chatStates.has(-1001)).toBeFalse();
    expect(chatStates.get(-1002)).toEqual({ lockdown });
    expect(chatStates.has(-1003)).toBeFalse();
  });

  test("中转发送目标全局唯一，扫描全部群只认显式启用的那个", () => {
    chatStates.set(-1001, { isAIChatEnabled: true });
    expect(getActiveProxySendTarget()).toBeUndefined();

    chatStates.set(-1002, { isProxySendEnabled: true });
    expect(getActiveProxySendTarget()).toBe(-1002);
  });
});
