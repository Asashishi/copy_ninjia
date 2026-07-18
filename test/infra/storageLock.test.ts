import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("../../src/infra/logger", () => ({
  logger: { error: mock((..._args: unknown[]): void => {}) },
}));

const { acquireSingleInstanceLock, getBotTokenFingerprint, releaseSingleInstanceLock } = await import("../../src/infra/storage");
const TOKEN_A = "123456789:test-secret-a";
const TOKEN_B = "987654321:test-secret-b";
let testDir: string;
let lockFilePath: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "storage-lock-test-"));
  lockFilePath = join(testDir, "bot.lock");
});

afterEach(async () => {
  await releaseSingleInstanceLock(TOKEN_A, lockFilePath);
  await releaseSingleInstanceLock(TOKEN_B, lockFilePath);
  rmSync(testDir, { recursive: true, force: true });
});

describe("single instance lock registry", () => {
  test("bot.lock 每行严格写 pid:sha256(token)，不落盘明文 token", async () => {
    await acquireSingleInstanceLock(TOKEN_A, lockFilePath);

    expect(readFileSync(lockFilePath, "utf8")).toBe(`${process.pid}:${getBotTokenFingerprint(TOKEN_A)}\n`);
    expect(readFileSync(lockFilePath, "utf8")).not.toContain(TOKEN_A);
    expect(existsSync(`${lockFilePath}.guard`)).toBe(false);
  });

  test("不同 token 也不能并发使用同一个数据目录", async () => {
    await acquireSingleInstanceLock(TOKEN_A, lockFilePath);
    await expect(acquireSingleInstanceLock(TOKEN_B, lockFilePath)).rejects.toThrow("different token");
    expect(readFileSync(lockFilePath, "utf8")).toBe(`${process.pid}:${getBotTokenFingerprint(TOKEN_A)}\n`);
  });

  test("相同 token 已有活 owner 时拒绝重复启动", async () => {
    await acquireSingleInstanceLock(TOKEN_A, lockFilePath);
    await expect(acquireSingleInstanceLock(TOKEN_A, lockFilePath)).rejects.toThrow("same token");
  });

  test("下一次操作清理崩溃进程留下的死 PID 行", async () => {
    const stalePid = 2_147_483_647;
    writeFileSync(lockFilePath, `${stalePid}:${getBotTokenFingerprint(TOKEN_A)}\n`);

    await acquireSingleInstanceLock(TOKEN_A, lockFilePath);

    expect(readFileSync(lockFilePath, "utf8")).toBe(`${process.pid}:${getBotTokenFingerprint(TOKEN_A)}\n`);
  });

  test("guard 回收中再次崩溃留下的 recovery 不会永久阻止启动", async () => {
    const stalePid = 2_147_483_647;
    writeFileSync(`${lockFilePath}.guard`, String(stalePid));
    writeFileSync(`${lockFilePath}.guard.recovery`, String(stalePid));

    await acquireSingleInstanceLock(TOKEN_A, lockFilePath);

    expect(existsSync(`${lockFilePath}.guard`)).toBe(false);
    expect(existsSync(`${lockFilePath}.guard.recovery`)).toBe(false);
  });

  test("旧格式或损坏内容直接拒绝，不做自动兼容/迁移", async () => {
    writeFileSync(lockFilePath, String(process.pid));

    await expect(acquireSingleInstanceLock(TOKEN_A, lockFilePath)).rejects.toThrow("repair it manually");
    expect(readFileSync(lockFilePath, "utf8")).toBe(String(process.pid));
  });
});
