import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstanceLockOptions } from "../../packages/infra/storage/instanceLock";
import type { ProcessIdentity } from "../../packages/types/storage";

mock.module("../../packages/infra/logger", () => ({
  logger: { error: mock((..._args: unknown[]): void => {}) },
}));

const {
  acquireSingleInstanceLock,
  getBotTokenFingerprint,
  parseLinuxProcessStat,
  readLinuxProcessIdentity,
  releaseSingleInstanceLock,
} = await import("../../packages/infra/storage/instanceLock");
const TOKEN_A = "123456789:test-secret-a";
const TOKEN_B = "987654321:test-secret-b";
const BOOT_A = "11111111-1111-4111-8111-111111111111";
const BOOT_B = "22222222-2222-4222-8222-222222222222";
let testDir: string;
let lockFilePath: string;

function identity(pid: number, startTimeTicks: string, bootId: string = BOOT_A): ProcessIdentity {
  return { pid, startTimeTicks, bootId };
}

function ownerText(owner: ProcessIdentity): string {
  return `v2:${owner.pid}:${owner.startTimeTicks}:${owner.bootId}`;
}

function registryText(owner: ProcessIdentity, token: string): string {
  return `${ownerText(owner)}:${getBotTokenFingerprint(token)}\n`;
}

function lockOptions(currentIdentity: ProcessIdentity, liveIdentities: ProcessIdentity[]): InstanceLockOptions {
  const identities = new Map<number, ProcessIdentity>(liveIdentities.map((owner) => [owner.pid, owner]));
  return {
    currentIdentity,
    readProcessIdentity: async (pid) => identities.get(pid) ?? null,
  };
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "storage-lock-test-"));
  lockFilePath = join(testDir, "bot.lock");
});

afterEach(async () => {
  // 部分用例刻意留下需要人工处理的损坏锁；生产 release 必须传播错误，
  // 测试夹具清理则直接删除整个临时目录，不把预期错误变成 afterEach 失败。
  await releaseSingleInstanceLock(TOKEN_A, lockFilePath).catch((): undefined => undefined);
  await releaseSingleInstanceLock(TOKEN_B, lockFilePath).catch((): undefined => undefined);
  rmSync(testDir, { recursive: true, force: true });
});

describe("single instance lock registry", () => {
  test("bot.lock 严格写 v2 完整进程身份与 token 指纹，不落盘明文 token", async () => {
    const current: ProcessIdentity = (await readLinuxProcessIdentity(process.pid))!;
    await acquireSingleInstanceLock(TOKEN_A, lockFilePath);

    expect(readFileSync(lockFilePath, "utf8")).toBe(registryText(current, TOKEN_A));
    expect(readFileSync(lockFilePath, "utf8")).not.toContain(TOKEN_A);
    expect(existsSync(`${lockFilePath}.guard`)).toBe(false);
  });

  test("不同 token 也不能并发使用同一个数据目录", async () => {
    await acquireSingleInstanceLock(TOKEN_A, lockFilePath);
    await expect(acquireSingleInstanceLock(TOKEN_B, lockFilePath)).rejects.toThrow("different token");
    const current: ProcessIdentity = (await readLinuxProcessIdentity(process.pid))!;
    expect(readFileSync(lockFilePath, "utf8")).toBe(registryText(current, TOKEN_A));
  });

  test("相同 token 已有活 owner 时拒绝重复启动", async () => {
    await acquireSingleInstanceLock(TOKEN_A, lockFilePath);
    await expect(acquireSingleInstanceLock(TOKEN_A, lockFilePath)).rejects.toThrow("same token");
  });

  test("下一次操作清理当前 v2 格式中已不存在的进程身份", async () => {
    const stalePid = 2_147_483_647;
    writeFileSync(lockFilePath, registryText(identity(stalePid, "10"), TOKEN_A));

    await acquireSingleInstanceLock(TOKEN_A, lockFilePath);

    const current: ProcessIdentity = (await readLinuxProcessIdentity(process.pid))!;
    expect(readFileSync(lockFilePath, "utf8")).toBe(registryText(current, TOKEN_A));
  });

  test("PID 相同但 starttime 不同视为 stale owner，而完整身份相同仍拒绝抢锁", async () => {
    const oldOwner: ProcessIdentity = identity(process.pid, "100");
    const current: ProcessIdentity = identity(process.pid, "200");
    const options: InstanceLockOptions = lockOptions(current, [current]);
    writeFileSync(lockFilePath, registryText(oldOwner, TOKEN_A));

    await acquireSingleInstanceLock(TOKEN_A, lockFilePath, options);
    expect(readFileSync(lockFilePath, "utf8")).toBe(registryText(current, TOKEN_A));
    await expect(acquireSingleInstanceLock(TOKEN_A, lockFilePath, options)).rejects.toThrow("same token");
  });

  test("PID 与 starttime 相同但 boot_id 不同视为上次开机遗留 owner", async () => {
    const oldOwner: ProcessIdentity = identity(process.pid, "300", BOOT_A);
    const current: ProcessIdentity = identity(process.pid, "300", BOOT_B);
    const options: InstanceLockOptions = lockOptions(current, [current]);
    writeFileSync(lockFilePath, registryText(oldOwner, TOKEN_A));

    await acquireSingleInstanceLock(TOKEN_A, lockFilePath, options);
    expect(readFileSync(lockFilePath, "utf8")).toBe(registryText(current, TOKEN_A));
  });

  test("guard/recovery 的 PID 被复用时按完整身份回收，不被同 PID 新进程阻塞", async () => {
    const staleOwner: ProcessIdentity = identity(process.pid, "700");
    const current: ProcessIdentity = identity(process.pid, "800");
    const options: InstanceLockOptions = lockOptions(current, [current]);
    writeFileSync(`${lockFilePath}.guard`, ownerText(staleOwner));
    writeFileSync(`${lockFilePath}.guard.recovery`, ownerText(staleOwner));

    await acquireSingleInstanceLock(TOKEN_A, lockFilePath, options);

    expect(existsSync(`${lockFilePath}.guard`)).toBe(false);
    expect(existsSync(`${lockFilePath}.guard.recovery`)).toBe(false);
    expect(readFileSync(lockFilePath, "utf8")).toBe(registryText(current, TOKEN_A));
  });

  test("完整身份仍活跃的 v2 guard 原样保留并拒绝抢锁", async () => {
    const current: ProcessIdentity = identity(process.pid, "900");
    const guardPath: string = `${lockFilePath}.guard`;
    const options: InstanceLockOptions = lockOptions(current, [current]);
    writeFileSync(guardPath, ownerText(current));

    await expect(acquireSingleInstanceLock(TOKEN_A, lockFilePath, options)).rejects.toThrow("updating");
    expect(readFileSync(guardPath, "utf8")).toBe(ownerText(current));
  });

  test("旧 pid:tokenFingerprint registry 原样保留并要求人工处理，不检查 PID 生死", async () => {
    const oldContent: string = `2147483647:${getBotTokenFingerprint(TOKEN_A)}\n`;
    writeFileSync(lockFilePath, oldContent);

    await expect(acquireSingleInstanceLock(TOKEN_A, lockFilePath)).rejects.toThrow("repair it manually");
    expect(readFileSync(lockFilePath, "utf8")).toBe(oldContent);
  });

  test("旧纯 PID guard 原样保留并要求人工处理", async () => {
    const guardPath: string = `${lockFilePath}.guard`;
    writeFileSync(guardPath, "2147483647");

    await expect(acquireSingleInstanceLock(TOKEN_A, lockFilePath)).rejects.toThrow("repair it manually");
    expect(readFileSync(guardPath, "utf8")).toBe("2147483647");
    expect(existsSync(lockFilePath)).toBe(false);
  });

  test("旧纯 PID recovery 原样保留并要求人工处理", async () => {
    const staleOwner: ProcessIdentity = identity(2_147_483_647, "10");
    const guardPath: string = `${lockFilePath}.guard`;
    const recoveryPath: string = `${guardPath}.recovery`;
    writeFileSync(guardPath, ownerText(staleOwner));
    writeFileSync(recoveryPath, String(staleOwner.pid));

    await expect(acquireSingleInstanceLock(TOKEN_A, lockFilePath)).rejects.toThrow("repair it manually");
    expect(readFileSync(guardPath, "utf8")).toBe(ownerText(staleOwner));
    expect(readFileSync(recoveryPath, "utf8")).toBe(String(staleOwner.pid));
  });

  test("损坏或空 registry 原样保留并要求人工处理", async () => {
    for (const content of ["broken\n", ""]) {
      writeFileSync(lockFilePath, content);

      await expect(acquireSingleInstanceLock(TOKEN_A, lockFilePath)).rejects.toThrow("repair it manually");
      expect(readFileSync(lockFilePath, "utf8")).toBe(content);
    }
  });

  test("释放只删除完整身份匹配的 owner，不按相同 PID 误删新 owner", async () => {
    const releasingOwner: ProcessIdentity = identity(process.pid, "400");
    const replacementOwner: ProcessIdentity = identity(process.pid, "500");
    const replacementOptions: InstanceLockOptions = lockOptions(releasingOwner, [replacementOwner]);
    writeFileSync(lockFilePath, registryText(replacementOwner, TOKEN_A));

    await releaseSingleInstanceLock(TOKEN_A, lockFilePath, replacementOptions);
    expect(readFileSync(lockFilePath, "utf8")).toBe(registryText(replacementOwner, TOKEN_A));

    await releaseSingleInstanceLock(TOKEN_A, lockFilePath, lockOptions(replacementOwner, [replacementOwner]));
    expect(existsSync(lockFilePath)).toBe(false);
  });

  test("进程身份读取异常时 fail-closed，不清理当前 v2 owner", async () => {
    const current: ProcessIdentity = identity(process.pid, "600");
    writeFileSync(lockFilePath, registryText(current, TOKEN_A));
    const options: InstanceLockOptions = {
      currentIdentity: current,
      readProcessIdentity: async () => { throw new Error("proc unavailable"); },
    };

    await expect(acquireSingleInstanceLock(TOKEN_A, lockFilePath, options)).rejects.toThrow("proc unavailable");
    expect(readFileSync(lockFilePath, "utf8")).toBe(registryText(current, TOKEN_A));
  });

  test("释放时身份读取异常向调用方传播，并原样保留 owner", async () => {
    const current: ProcessIdentity = identity(process.pid, "601");
    writeFileSync(lockFilePath, registryText(current, TOKEN_A));
    const options: InstanceLockOptions = {
      currentIdentity: current,
      readProcessIdentity: async (): Promise<never> => {
        throw new Error("release proc unavailable");
      },
    };

    await expect(releaseSingleInstanceLock(TOKEN_A, lockFilePath, options))
      .rejects.toThrow("release proc unavailable");
    expect(readFileSync(lockFilePath, "utf8")).toBe(registryText(current, TOKEN_A));
  });

  test("/proc stat 解析兼容 comm 中的空格和右括号，并拒绝缺字段内容", () => {
    const fields: string[] = ["S", ...Array.from({ length: 19 }, (_, index) => String(index + 4))];
    fields[19] = "987654321";
    const parsed = parseLinuxProcessStat(`321 (worker name ) copy) ${fields.join(" ")}`);

    expect(parsed).toEqual({ pid: 321, state: "S", startTimeTicks: "987654321" });
    expect(() => parseLinuxProcessStat("321 (short) S 1 2")).toThrow("Invalid Linux");
  });

  test("真实 /proc reader 返回当前身份，不存在 PID 返回 null", async () => {
    const current: ProcessIdentity | null = await readLinuxProcessIdentity(process.pid);

    expect(current?.pid).toBe(process.pid);
    expect(current?.startTimeTicks).toMatch(/^\d+$/);
    expect(current?.bootId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(readLinuxProcessIdentity(2_147_483_647)).resolves.toBeNull();
  });
});
