import { describe, expect, test } from "bun:test";
import { StateStore } from "../../../src/infra/storage/stateStore";
import type { StateFileSchema } from "../../../src/types/chatState";

function schema(chatId: number): StateFileSchema {
  return {
    chats: { [String(chatId)]: { isAIChatEnabled: true } },
    globalCopy: { copiedUser: null },
  };
}

describe("StateStore", () => {
  test("注入 IO 后独立验证 schema 序列化与 latest-only 写入", async () => {
    const writes: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const store = new StateStore({
      stateFilePath: "/virtual/state.json",
      writeText: async (_path, content) => {
        writes.push(content);
        if (writes.length === 1) await firstBlocked;
      },
    });

    const first = store.save(schema(1));
    const second = store.save(schema(2));
    const third = store.save(schema(3));
    releaseFirst!();
    await Promise.all([first, second, third]);

    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[1]!)).toEqual(schema(3));
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
    expect(attempts).toBe(2);
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

  test("load 通过当前严格 codec 解码，不存在文件返回 null", async () => {
    const missing = new StateStore({ readText: async () => null });
    await expect(missing.load()).resolves.toBeNull();

    const expected = schema(5);
    const existing = new StateStore({ readText: async () => JSON.stringify(expected) });
    await expect(existing.load()).resolves.toEqual(expected);
    missing.dispose();
    existing.dispose();
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
