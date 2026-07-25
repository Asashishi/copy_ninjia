import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realFs from "node:fs";
import * as realFsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 原子写的全部价值都在失败路径上：write/fsync/close/rename 各自失败后都必须
 * 清掉临时文件、保留原始错误，并且绝不把半份数据 rename 到目标路径。这些分支
 * 在正常运行里永远走不到，只能靠故障注入覆盖（见 package.json 的
 * test:fault-injection）。
 */
// mock.module 会就地改写命名空间对象；真实实现必须先快照，否则包装会自我递归。
const realFsSnapshot = { ...realFs };
const realFsPromisesSnapshot = { ...realFsPromises };
const realOpen = realFsPromisesSnapshot.open;
const realRename = realFsPromisesSnapshot.rename;
const realUnlink = realFsPromisesSnapshot.unlink;
const realOpenSync = realFsSnapshot.openSync;
const realWriteFileSync = realFsSnapshot.writeFileSync;
const realFsyncSync = realFsSnapshot.fsyncSync;
const realCloseSync = realFsSnapshot.closeSync;
const realRenameSync = realFsSnapshot.renameSync;
const realUnlinkSync = realFsSnapshot.unlinkSync;

interface InjectedFailure {
  error: Error;
  /** 第几次调用该操作时失败；0 表示每次都失败。 */
  onCall: number;
}

const failures = new Map<string, InjectedFailure>();
const callCounts = new Map<string, number>();
/** 实际执行到的操作序列，用来断言清理确实发生过。 */
const operations: string[] = [];

function injectFailure(operation: string, message: string, onCall: number = 0): void {
  failures.set(operation, { error: new Error(message), onCall });
}

function step(name: string): void {
  operations.push(name);
  const count: number = (callCounts.get(name) ?? 0) + 1;
  callCounts.set(name, count);
  const failure: InjectedFailure | undefined = failures.get(name);
  if (failure && (failure.onCall === 0 || failure.onCall === count)) throw failure.error;
}

mock.module("node:fs/promises", () => ({
  ...realFsPromisesSnapshot,
  open: async (path: unknown, flags: unknown, mode?: unknown) => {
    const handle = await realOpen(path as string, flags as string, mode as number | undefined);
    return {
      writeFile: async (data: unknown): Promise<void> => {
        step("writeFile");
        await handle.writeFile(data as string);
      },
      sync: async (): Promise<void> => {
        step("sync");
        await handle.sync();
      },
      close: async (): Promise<void> => {
        // 即使注入失败也要真正释放 fd，否则测试进程会泄漏句柄。
        await handle.close();
        step("close");
      },
    };
  },
  rename: async (from: unknown, to: unknown): Promise<void> => {
    step("rename");
    await realRename(from as string, to as string);
  },
  unlink: async (path: unknown): Promise<void> => {
    step("unlink");
    await realUnlink(path as string);
  },
}));

mock.module("node:fs", () => ({
  ...realFsSnapshot,
  openSync: (path: unknown, flags: unknown, mode?: unknown): number =>
    realOpenSync(path as string, flags as string, mode as number | undefined),
  writeFileSync: (fd: unknown, data: unknown): void => {
    step("writeFileSync");
    realWriteFileSync(fd as number, data as string);
  },
  fsyncSync: (fd: unknown): void => {
    step("fsyncSync");
    realFsyncSync(fd as number);
  },
  closeSync: (fd: unknown): void => {
    realCloseSync(fd as number);
    step("closeSync");
  },
  renameSync: (from: unknown, to: unknown): void => {
    step("renameSync");
    realRenameSync(from as string, to as string);
  },
  unlinkSync: (path: unknown): void => {
    step("unlinkSync");
    realUnlinkSync(path as string);
  },
}));

const { atomicWriteText, atomicWriteTextSync } = await import("../../src/libs/atomicFile");

let testDir: string;
let targetPath: string;

/** 目录里是否还留着孤儿临时文件。 */
function leftoverTempFiles(): string[] {
  return realFsSnapshot.readdirSync(testDir).filter((entry) => entry.endsWith(".tmp"));
}

beforeEach(() => {
  failures.clear();
  callCounts.clear();
  operations.length = 0;
  testDir = realFsSnapshot.mkdtempSync(join(tmpdir(), "atomic-file-test-"));
  targetPath = join(testDir, "state.json");
});

afterEach(() => {
  realFsSnapshot.rmSync(testDir, { recursive: true, force: true });
});

describe("atomicWriteText 的失败清理", () => {
  test("写入失败时删除临时文件、保留原始错误且不 rename", async () => {
    injectFailure("writeFile", "injected write failure");

    await expect(atomicWriteText(targetPath, "payload")).rejects.toThrow("injected write failure");

    expect(operations).toContain("unlink");
    expect(operations).not.toContain("rename");
    expect(leftoverTempFiles()).toEqual([]);
    expect(realFsSnapshot.existsSync(targetPath)).toBe(false);
  });

  test("fsync 失败时同样清理并保留原始错误", async () => {
    injectFailure("sync", "injected fsync failure");

    await expect(atomicWriteText(targetPath, "payload")).rejects.toThrow("injected fsync failure");

    expect(operations).toContain("unlink");
    expect(operations).not.toContain("rename");
    expect(leftoverTempFiles()).toEqual([]);
  });

  test("close 失败时不尝试 rename，临时文件仍被清理", async () => {
    injectFailure("close", "injected close failure");

    await expect(atomicWriteText(targetPath, "payload")).rejects.toThrow("injected close failure");

    expect(operations).toContain("unlink");
    expect(operations).not.toContain("rename");
    expect(leftoverTempFiles()).toEqual([]);
    expect(realFsSnapshot.existsSync(targetPath)).toBe(false);
  });

  test("rename 失败时删除临时文件并保留原始错误", async () => {
    injectFailure("rename", "injected rename failure");

    await expect(atomicWriteText(targetPath, "payload")).rejects.toThrow("injected rename failure");

    expect(operations).toContain("unlink");
    expect(leftoverTempFiles()).toEqual([]);
    expect(realFsSnapshot.existsSync(targetPath)).toBe(false);
  });

  test("清理本身失败时不掩盖原始写入错误", async () => {
    injectFailure("writeFile", "injected write failure");
    injectFailure("unlink", "injected unlink failure");

    await expect(atomicWriteText(targetPath, "payload")).rejects.toThrow("injected write failure");
  });
});

describe("atomicWriteTextSync 的失败清理", () => {
  test("写入失败时关闭 fd、删除临时文件并保留原始错误", () => {
    injectFailure("writeFileSync", "injected sync write failure");

    expect(() => atomicWriteTextSync(targetPath, "payload")).toThrow("injected sync write failure");

    expect(operations).toContain("closeSync");
    expect(operations).toContain("unlinkSync");
    expect(operations).not.toContain("renameSync");
    expect(leftoverTempFiles()).toEqual([]);
  });

  test("清理阶段 closeSync 与 unlinkSync 也失败时仍抛原始写入错误", () => {
    injectFailure("fsyncSync", "injected sync fsync failure");
    injectFailure("closeSync", "injected sync close failure");
    injectFailure("unlinkSync", "injected sync unlink failure");

    expect(() => atomicWriteTextSync(targetPath, "payload")).toThrow("injected sync fsync failure");

    expect(operations).toContain("closeSync");
    expect(operations).toContain("unlinkSync");
    expect(operations).not.toContain("renameSync");
  });

  test("成功路径上 closeSync 失败时不 rename，临时文件被清理", () => {
    injectFailure("closeSync", "injected sync close failure");

    expect(() => atomicWriteTextSync(targetPath, "payload")).toThrow("injected sync close failure");

    expect(operations).toContain("unlinkSync");
    expect(operations).not.toContain("renameSync");
    expect(leftoverTempFiles()).toEqual([]);
    expect(realFsSnapshot.existsSync(targetPath)).toBe(false);
  });

  test("renameSync 失败时删除临时文件并保留原始错误", () => {
    injectFailure("renameSync", "injected sync rename failure");

    expect(() => atomicWriteTextSync(targetPath, "payload")).toThrow("injected sync rename failure");

    expect(operations).toContain("unlinkSync");
    expect(leftoverTempFiles()).toEqual([]);
    expect(realFsSnapshot.existsSync(targetPath)).toBe(false);
  });

  test("rename 已成功后目录 fsync 失败：抛出原始错误但不误删已发布的目标文件", () => {
    // 第 1 次 fsyncSync 是写临时文件，第 2 次才是 syncDirectorySync 的目录同步。
    injectFailure("fsyncSync", "injected directory fsync failure", 2);

    expect(() => atomicWriteTextSync(targetPath, "payload")).toThrow("injected directory fsync failure");

    expect(operations).toContain("renameSync");
    // 清理里的 unlinkSync 会因为临时路径已被 rename 掉而 ENOENT，必须被吞掉且
    // 不影响原始错误；目标文件已经发布，不能被删。
    expect(realFsSnapshot.existsSync(targetPath)).toBe(true);
    expect(realFsSnapshot.readFileSync(targetPath, "utf8")).toBe("payload");
    expect(leftoverTempFiles()).toEqual([]);
  });
});
