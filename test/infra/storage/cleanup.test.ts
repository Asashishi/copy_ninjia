import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupOrphanedTempFiles } from "../../../src/infra/storage/cleanup";
import { readLinuxProcessIdentity, type ProcessIdentity } from "../../../src/infra/storage/instanceLock";

describe("storage startup cleanup", () => {
  test("只删除 state/lock 原子写临时文件，目录扫描与删除均可注入", async () => {
    const removed: string[] = [];
    await cleanupOrphanedTempFiles({
      stateFilePath: "/virtual/state.json",
      lockFilePath: "/virtual/bot.lock",
      readDirectory: async () => [
        ".state.json.1.uuid.tmp",
        ".state.json.bak.1.uuid.tmp",
        ".bot.lock.1.uuid.tmp",
        ".other.json.1.uuid.tmp",
        "bot.lock.guard.candidate.42.11111111-1111-4111-8111-111111111111",
        "bot.lock.guard.candidate.43.22222222-2222-4222-8222-222222222222",
        "bot.lock.guard.candidate.bad.33333333-3333-4333-8333-333333333333",
        "bot.lock.guard.recovery",
        "state.json",
      ],
      isInactiveLockOwner: async (path) => !path.includes("candidate.43."),
      removeFile: async (path) => {
        removed.push(path);
      },
    });

    expect(removed).toEqual([
      "/virtual/.state.json.1.uuid.tmp",
      "/virtual/.state.json.bak.1.uuid.tmp",
      "/virtual/.bot.lock.1.uuid.tmp",
      "/virtual/bot.lock.guard.candidate.42.11111111-1111-4111-8111-111111111111",
      "/virtual/bot.lock.guard.recovery",
    ]);
  });

  test("目录扫描失败时安全返回，不尝试删除任何文件", async () => {
    let removeCalls: number = 0;

    await expect(cleanupOrphanedTempFiles({
      stateFilePath: "/virtual/state.json",
      lockFilePath: "/virtual/bot.lock",
      readDirectory: async () => {
        throw new Error("injected readdir failure");
      },
      removeFile: async () => {
        removeCalls++;
      },
    })).resolves.toBeUndefined();

    expect(removeCalls).toBe(0);
  });

  test("单个删除失败或文件已消失时继续清理后续目标", async () => {
    const attempted: string[] = [];

    await cleanupOrphanedTempFiles({
      stateFilePath: "/virtual/state.json",
      lockFilePath: "/virtual/bot.lock",
      readDirectory: async () => [
        ".state.json.1.first.tmp",
        ".state.json.1.gone.tmp",
        ".bot.lock.1.last.tmp",
      ],
      removeFile: async (path) => {
        attempted.push(path);
        if (path.endsWith("first.tmp")) throw new Error("injected unlink failure");
        if (path.endsWith("gone.tmp")) {
          const error: NodeJS.ErrnoException = new Error("gone");
          error.code = "ENOENT";
          throw error;
        }
      },
    });

    expect(attempted).toEqual([
      "/virtual/.state.json.1.first.tmp",
      "/virtual/.state.json.1.gone.tmp",
      "/virtual/.bot.lock.1.last.tmp",
    ]);
  });
});

/**
 * 上面的用例都注入了 isInactiveLockOwner 替身，真实的 hasInactiveCurrentFormatOwner
 * 从未被执行过。它是「不认识的内容一律不删」这条 fail-closed 判定的唯一实现，
 * 必须用真实文件与真实 /proc 身份覆盖。
 */
describe("guard 归属判定的真实实现", () => {
  const BOOT_ID = "11111111-1111-4111-8111-111111111111";
  /** 远超 Linux pid_max，/proc 下必然不存在。 */
  const DEAD_PID = 999_999_999;
  let testDir: string;
  let lockFilePath: string;
  let stateFilePath: string;

  function candidateName(pid: number, uuid: string): string {
    return `bot.lock.guard.candidate.${pid}.${uuid}`;
  }

  function writeCandidate(name: string, content: string): void {
    writeFileSync(join(testDir, name), content);
  }

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cleanup-owner-test-"));
    lockFilePath = join(testDir, "bot.lock");
    stateFilePath = join(testDir, "state.json");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("只删除当前格式且归属进程确已消失的 guard 残留", async () => {
    const current: ProcessIdentity = (await readLinuxProcessIdentity(process.pid))!;
    const unparseable: string = candidateName(42, "11111111-1111-4111-8111-111111111111");
    const unsafePid: string = candidateName(43, "22222222-2222-4222-8222-222222222222");
    const liveOwner: string = candidateName(44, "33333333-3333-4333-8333-333333333333");
    const deadOwner: string = candidateName(45, "44444444-4444-4444-8444-444444444444");
    const recycledPid: string = candidateName(46, "55555555-5555-4555-8555-555555555555");

    // 旧格式/损坏内容：认不出归属，绝不能删。
    writeCandidate(unparseable, "legacy-owner-format");
    // pid 超出安全整数范围：同样拒绝。
    writeCandidate(unsafePid, `v2:99999999999999999999:1234:${BOOT_ID}`);
    // 归属进程就是当前测试进程，仍然活着。
    writeCandidate(liveOwner, `v2:${current.pid}:${current.startTimeTicks}:${current.bootId}`);
    // 归属进程已经不存在。
    writeCandidate(deadOwner, `v2:${DEAD_PID}:1234:${BOOT_ID}`);
    // pid 还在，但 starttime 对不上——是被复用的 pid，原归属进程已消失。
    writeCandidate(recycledPid, `v2:${current.pid}:1:${current.bootId}`);

    await cleanupOrphanedTempFiles({ stateFilePath, lockFilePath });

    const remaining: string[] = readdirSync(testDir).sort();
    expect(remaining).toEqual([unparseable, unsafePid, liveOwner].sort());
    expect(existsSync(join(testDir, deadOwner))).toBe(false);
    expect(existsSync(join(testDir, recycledPid))).toBe(false);
  });

  test("bot.lock.guard.recovery 同样按归属判定，读不出内容时保留", async () => {
    const recoveryPath: string = join(testDir, "bot.lock.guard.recovery");
    writeFileSync(recoveryPath, `v2:${DEAD_PID}:1234:${BOOT_ID}`);

    await cleanupOrphanedTempFiles({ stateFilePath, lockFilePath });
    expect(existsSync(recoveryPath)).toBe(false);

    const current: ProcessIdentity = (await readLinuxProcessIdentity(process.pid))!;
    writeFileSync(recoveryPath, `v2:${current.pid}:${current.startTimeTicks}:${current.bootId}`);

    await cleanupOrphanedTempFiles({ stateFilePath, lockFilePath });
    expect(existsSync(recoveryPath)).toBe(true);
  });
});
