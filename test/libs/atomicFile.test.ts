import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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
const realOpenSync = realFsSnapshot.openSync;
const realWriteFileSync = realFsSnapshot.writeFileSync;
const realWriteSync = realFsSnapshot.writeSync;
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
const writeLengthLimits: number[] = [];
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
      chmod: async (fileMode: unknown): Promise<void> => {
        step("chmod");
        await handle.chmod(fileMode as number);
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
}));

// 异步清理走 Bun 原生 BunFile.delete()（见 packages/libs/atomicFile.ts），
// mock.module("node:fs/promises") 拦不到它。这里就地包一层 Bun.file：delete 仍按
// "unlink" 记名并可注入失败，其余属性绑回真实 BunFile，不影响同 isolate 的其它读写。
// 与摘不掉的 mock.module 不同，Bun.file 是普通可写属性，afterAll 里原样还原——
// 否则非隔离运行时这层包装会带着注入的 unlink 失败泄漏进后续测试文件。
const realBunFile = Bun.file;
Bun.file = ((path: any, options?: any): any => {
  const file = realBunFile(path, options);
  return new Proxy(file, {
    get(target: any, property: string | symbol): unknown {
      if (property === "delete" || property === "unlink") {
        return async (): Promise<void> => {
          step("unlink");
          await target.delete();
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}) as typeof Bun.file;

mock.module("node:fs", () => ({
  ...realFsSnapshot,
  openSync: (path: unknown, flags: unknown, mode?: unknown): number =>
    realOpenSync(path as string, flags as string, mode as number | undefined),
  writeFileSync: (fd: unknown, data: unknown): void => {
    step("writeFileSync");
    realWriteFileSync(fd as number, data as string);
  },
  writeSync: (...args: [
    unknown,
    unknown,
    unknown,
    unknown,
    unknown
  ]): number => {
    const [fd, buffer, offset, length, position] = args;
    step("writeSync");
    const lengthLimit: number | undefined = writeLengthLimits.shift();
    if (lengthLimit === 0) return 0;
    return realWriteSync(
      fd as number,
      buffer as Buffer,
      offset as number,
      Math.min(length as number, lengthLimit ?? Number.POSITIVE_INFINITY),
      position as number | null
    );
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

const {
  atomicWriteText,
  atomicWriteTextChunksSync,
  atomicWriteTextSync,
} = await import("../../packages/libs/atomicFile");

let testDir: string;
let targetPath: string;

/** 目录里是否还留着孤儿临时文件。 */
function leftoverTempFiles(): string[] {
  return realFsSnapshot.readdirSync(testDir).filter((entry) => entry.endsWith(".tmp"));
}

beforeEach(() => {
  failures.clear();
  callCounts.clear();
  writeLengthLimits.length = 0;
  operations.length = 0;
  testDir = realFsSnapshot.mkdtempSync(join(tmpdir(), "atomic-file-test-"));
  targetPath = join(testDir, "state.json");
});

afterEach(() => {
  realFsSnapshot.rmSync(testDir, { recursive: true, force: true });
});

afterAll(() => {
  Bun.file = realBunFile;
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

describe("atomicWriteText 的权限接管", () => {
  test("沿用目标原有权限：部署方 chmod 0600 过的文件不被一次普通写入放宽", async () => {
    // 临时文件是新建的，`0666 & ~umask`（常见 0644）与目标原有权限没有任何关系，
    // 而 rename 直接把它替换上去——config/whitelist.json、state.json、bot.lock
    // 都会在一次普通写入后被静默放宽，且不留日志。
    realFsSnapshot.writeFileSync(targetPath, "old");
    realFsSnapshot.chmodSync(targetPath, 0o600);

    await atomicWriteText(targetPath, "new");

    expect(realFsSnapshot.statSync(targetPath).mode & 0o777).toBe(0o600);
    expect(realFsSnapshot.readFileSync(targetPath, "utf8")).toBe("new");
  });

  test("显式 mode 只用于首次创建，已有目标仍保留部署方权限", async () => {
    realFsSnapshot.writeFileSync(targetPath, "old");
    realFsSnapshot.chmodSync(targetPath, 0o600);

    await atomicWriteText(targetPath, "new", 0o640);

    expect(realFsSnapshot.statSync(targetPath).mode & 0o777).toBe(0o600);
  });

  test("目标还不存在时不强加权限，交给 open 的默认值", async () => {
    await atomicWriteText(targetPath, "new");

    expect(realFsSnapshot.existsSync(targetPath)).toBe(true);
    expect(operations).not.toContain("chmod");
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

describe("atomicWriteTextChunksSync 的分块与失败清理", () => {
  test("逐块写出完整内容并返回准确字节数", () => {
    const chunks: readonly string[] = ["{\n", "  \"值\": 1", "\n}"];

    expect(atomicWriteTextChunksSync(targetPath, chunks)).toBe(
      Buffer.byteLength(chunks.join(""))
    );

    expect(realFsSnapshot.readFileSync(targetPath, "utf8")).toBe(
      chunks.join("")
    );
    expect(callCounts.get("writeSync")).toBe(chunks.length);
    expect(leftoverTempFiles()).toEqual([]);
  });

  test("中途分块写失败时保留原目标并清掉临时文件", () => {
    realFsSnapshot.writeFileSync(targetPath, "original");
    injectFailure("writeSync", "injected chunk write failure", 2);

    expect(() => atomicWriteTextChunksSync(
      targetPath,
      ["first", "second", "third"]
    )).toThrow("injected chunk write failure");

    expect(realFsSnapshot.readFileSync(targetPath, "utf8")).toBe("original");
    expect(operations).toContain("closeSync");
    expect(operations).toContain("unlinkSync");
    expect(operations).not.toContain("renameSync");
    expect(leftoverTempFiles()).toEqual([]);
  });

  test("底层 short write 会循环写完当前块", () => {
    writeLengthLimits.push(2);

    expect(atomicWriteTextChunksSync(targetPath, ["abcdef"])).toBe(6);

    expect(callCounts.get("writeSync")).toBe(2);
    expect(realFsSnapshot.readFileSync(targetPath, "utf8")).toBe("abcdef");
  });

  test("底层零字节写快速失败且不发布半份目标", () => {
    realFsSnapshot.writeFileSync(targetPath, "original");
    writeLengthLimits.push(0);

    expect(() => atomicWriteTextChunksSync(
      targetPath,
      ["payload"]
    )).toThrow("no valid progress");

    expect(realFsSnapshot.readFileSync(targetPath, "utf8")).toBe("original");
    expect(operations).not.toContain("renameSync");
    expect(leftoverTempFiles()).toEqual([]);
  });

  test("空 iterable 原子发布零字节文件", () => {
    expect(atomicWriteTextChunksSync(targetPath, [])).toBe(0);
    expect(realFsSnapshot.readFileSync(targetPath, "utf8")).toBe("");
    expect(leftoverTempFiles()).toEqual([]);
  });
});

describe("同步原子写的权限接管", () => {
  // 临时文件是新建的，`0666 & ~umask`（常见 0644）与目标原有权限没有任何关系，
  // 而 rename 直接把它替换上去。异步版 atomicWriteText 早就为此显式读了目标现有
  // mode，同步版却漏了——追加型日志正是刻意不传 mode 来「保持原有部署权限策略」的
  // （见 workers/diskIO/appendOnlyDayFile.ts），于是每次重写都把它悄悄放宽。
  function modeOf(path: string): number {
    return realFsSnapshot.statSync(path).mode & 0o777;
  }

  test("不传 mode 时沿用目标文件当前权限，不放宽到 umask 默认值", () => {
    realFsSnapshot.writeFileSync(targetPath, "original");
    realFsSnapshot.chmodSync(targetPath, 0o600);

    atomicWriteTextSync(targetPath, "rewritten");

    expect(modeOf(targetPath)).toBe(0o600);
    expect(realFsSnapshot.readFileSync(targetPath, "utf8")).toBe("rewritten");
  });

  test("分块写同样沿用目标现有权限", () => {
    realFsSnapshot.writeFileSync(targetPath, "original");
    realFsSnapshot.chmodSync(targetPath, 0o640);

    atomicWriteTextChunksSync(targetPath, ["a", "b"]);

    expect(modeOf(targetPath)).toBe(0o640);
  });

  test("显式 mode 不覆盖已有目标权限", () => {
    realFsSnapshot.writeFileSync(targetPath, "original");
    realFsSnapshot.chmodSync(targetPath, 0o600);

    atomicWriteTextSync(targetPath, "rewritten", 0o644);

    expect(modeOf(targetPath)).toBe(0o600);
  });

  test("目标不存在时没有可沿用的权限，交给 open 默认值", () => {
    atomicWriteTextSync(targetPath, "created");

    expect(realFsSnapshot.existsSync(targetPath)).toBeTrue();
    expect(realFsSnapshot.readFileSync(targetPath, "utf8")).toBe("created");
  });
});
