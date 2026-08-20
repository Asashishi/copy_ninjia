import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../helpers/loggerMock";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import * as realFsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { InstanceLockOptions } from "../../packages/infra/storage/instanceLock";
import type { ProcessIdentity } from "../../packages/types/storage";

/**
 * guard 协议的 candidate 是用 link() 直接发布成 bot.lock.guard 的，没有 rename
 * 兜底。这里注入可观测的文件句柄，断言数据与目录项都在 link() 之前落盘——
 * 否则掉电会留下内容为空/撕裂的 guard，只能人工 rm 才能重新启动。
 */
const operations: string[] = [];

// mock.module 会就地改写 node:fs/promises 的命名空间对象；真实实现必须在打桩
// 之前快照下来，否则包装函数会调回自己造成无限递归。
const realFs = { ...realFsPromises };
const realOpen = realFs.open;
const realLink = realFs.link;
let failCandidateSync: boolean = false;
let failCandidateDirectorySync: boolean = false;

mock.module("../../packages/infra/logger", () => ({
  logger: loggerStub({ error: mock((..._args: unknown[]): void => {}) }),
}));

mock.module("node:fs/promises", () => ({
  ...realFs,
  open: async (path: unknown, flags: unknown, mode?: unknown) => {
    const handle = await realOpen(path as string, flags as string, mode as number | undefined);
    const name: string = basename(String(path));
    return {
      writeFile: async (data: unknown): Promise<void> => {
        operations.push(`write:${name}`);
        await handle.writeFile(data as string);
      },
      sync: async (): Promise<void> => {
        operations.push(`sync:${name}`);
        if (failCandidateSync && name.startsWith("bot.lock.guard.candidate.")) {
          throw new Error("injected candidate fsync failure");
        }
        if (
          failCandidateDirectorySync &&
          name === basename(testDir) &&
          operations.some((entry) => entry.startsWith("close:bot.lock.guard.candidate."))
        ) {
          throw new Error("injected candidate directory fsync failure");
        }
        await handle.sync();
      },
      close: async (): Promise<void> => {
        operations.push(`close:${name}`);
        await handle.close();
      },
    };
  },
  link: async (existingPath: unknown, newPath: unknown): Promise<void> => {
    operations.push(`link:${basename(String(newPath))}`);
    await realLink(existingPath as string, newPath as string);
  },
}));

const { acquireSingleInstanceLock, releaseSingleInstanceLock } =
  await import("../../packages/infra/storage/instanceLock");

const TOKEN = "123456789:test-secret-durability";
const BOOT_ID = "11111111-1111-4111-8111-111111111111";
let testDir: string;
let lockFilePath: string;

function lockOptions(): InstanceLockOptions {
  const current: ProcessIdentity = { pid: process.pid, startTimeTicks: "4242", bootId: BOOT_ID };
  return {
    currentIdentity: current,
    readProcessIdentity: async (pid: number) => (pid === process.pid ? current : null),
  };
}

beforeEach(() => {
  operations.length = 0;
  failCandidateSync = false;
  failCandidateDirectorySync = false;
  testDir = mkdtempSync(join(tmpdir(), "storage-lock-durability-"));
  lockFilePath = join(testDir, "bot.lock");
});

afterEach(async () => {
  failCandidateSync = false;
  failCandidateDirectorySync = false;
  await releaseSingleInstanceLock(TOKEN, lockFilePath, lockOptions());
  rmSync(testDir, { recursive: true, force: true });
});

function guardCandidates(): string[] {
  return readdirSync(testDir).filter((entry) => entry.startsWith("bot.lock.guard.candidate."));
}

describe("bot.lock.guard 发布前的持久化", () => {
  test("candidate 的数据与目录项都在 link() 之前落盘", async () => {
    await acquireSingleInstanceLock(TOKEN, lockFilePath, lockOptions());

    const guardCandidate: string[] = operations.filter((entry) => entry.includes("bot.lock.guard.candidate."));
    const candidateWrite: number = operations.findIndex((entry) => entry.startsWith("write:bot.lock.guard.candidate."));
    const candidateSync: number = operations.findIndex((entry) => entry.startsWith("sync:bot.lock.guard.candidate."));
    const candidateClose: number = operations.findIndex((entry) => entry.startsWith("close:bot.lock.guard.candidate."));
    // 数据根 preflight 自己也会 fsync 一次根目录；只看 candidate 关闭之后的那次。
    const directorySync: number = operations.indexOf(`sync:${basename(testDir)}`, candidateClose);
    const guardLink: number = operations.indexOf("link:bot.lock.guard");

    expect(guardCandidate.length).toBeGreaterThan(0);
    expect(guardLink).toBeGreaterThanOrEqual(0);
    // 写 -> fsync 文件 -> close -> fsync 父目录 -> 才允许发布 guard。
    expect(candidateWrite).toBeGreaterThanOrEqual(0);
    expect(candidateSync).toBeGreaterThan(candidateWrite);
    expect(candidateClose).toBeGreaterThan(candidateSync);
    expect(directorySync).toBeGreaterThan(candidateClose);
    expect(guardLink).toBeGreaterThan(directorySync);
  });

  test("candidate 文件 fsync 失败时不遗留辅助文件", async () => {
    failCandidateSync = true;

    await expect(acquireSingleInstanceLock(TOKEN, lockFilePath, lockOptions()))
      .rejects.toThrow("injected candidate fsync failure");

    expect(guardCandidates()).toEqual([]);
  });

  test("candidate 目录 fsync 失败时不遗留辅助文件", async () => {
    failCandidateDirectorySync = true;

    await expect(acquireSingleInstanceLock(TOKEN, lockFilePath, lockOptions()))
      .rejects.toThrow("injected candidate directory fsync failure");

    expect(guardCandidates()).toEqual([]);
  });
});
