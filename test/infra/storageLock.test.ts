import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// storage.ts 的 logger 会连接磁盘 Worker；这里测试的只有锁文件协议，日志门面
// 用空实现隔离，避免单测额外启动后台线程。
mock.module("../../src/infra/logger", () => ({
  logger: { error: mock((..._args: unknown[]): void => {}) },
}));

const { acquireSingleInstanceLock, getSingleInstanceLockPath, releaseSingleInstanceLock } = await import("../../src/infra/storage");
const TOKEN = "123456789:test-secret-a";
let testDir: string;
let baseLockPath: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "storage-lock-test-"));
  baseLockPath = join(testDir, "bot.lock");
});

afterEach(async () => {
  await releaseSingleInstanceLock(TOKEN, baseLockPath);
  rmSync(testDir, { recursive: true, force: true });
});

describe("single instance lock recovery", () => {
  test("SHA-256 指纹按 token 分域且不在路径中泄露 token", () => {
    const firstPath = getSingleInstanceLockPath(TOKEN, baseLockPath);
    const samePath = getSingleInstanceLockPath(TOKEN, baseLockPath);
    const otherPath = getSingleInstanceLockPath("987654321:test-secret-b", baseLockPath);

    expect(firstPath).toBe(samePath);
    expect(firstPath).not.toBe(otherPath);
    expect(firstPath).not.toContain(TOKEN);
    expect(firstPath).toMatch(/^.*bot\.lock\.[0-9a-f]{64}$/);
  });

  test("不同 token 可在同一目录分别持有自己的锁", async () => {
    const otherToken = "987654321:test-secret-b";
    await acquireSingleInstanceLock(TOKEN, baseLockPath);
    await acquireSingleInstanceLock(otherToken, baseLockPath);

    expect(existsSync(getSingleInstanceLockPath(TOKEN, baseLockPath))).toBe(true);
    expect(existsSync(getSingleInstanceLockPath(otherToken, baseLockPath))).toBe(true);

    await releaseSingleInstanceLock(otherToken, baseLockPath);
  });

  test("回收进程崩溃留下的 stale bot.lock.recovery 后仍能自动启动", async () => {
    const lockPath = getSingleInstanceLockPath(TOKEN, baseLockPath);
    // 极大的合法正 PID 在测试环境中应不存在，用它模拟两份启动期崩溃残留。
    const stalePid = 2_147_483_647;
    writeFileSync(lockPath, String(stalePid));
    writeFileSync(`${lockPath}.recovery`, String(stalePid));

    await acquireSingleInstanceLock(TOKEN, baseLockPath);

    expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid));
    expect(existsSync(`${lockPath}.recovery`)).toBe(false);
  });
});
