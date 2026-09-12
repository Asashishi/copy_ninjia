/**
 * 持久化路径的只读启动检查（packages/libs/fileAccess.ts）。
 *
 * 这两个函数是 AGENTS.md「不为用户行为兜底」在文件权限上的落点：路径不具备运行
 * 账号所需的权限时必须在建立连接、对外服务之前以非零码退出，且错误只写路径、
 * 字段路径和期望形态——不 chmod、不降级、不回显内容。
 *
 * 拒绝分支用**缺失路径**驱动：`accessSync` 对「不存在」与「权限不足」抛的是同一
 * 类错误，两者在本函数里收敛到同一条拒绝，而缺失路径不依赖测试进程的 uid
 * （以 root 跑时 chmod 0 仍然可读写，那种夹具在 CI 与本机会给出不同结论）。
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertDirectoryReadableWritable,
  assertFileReadableWritable,
  inspectOptionalDirectory,
  inspectOptionalFile,
} from "../../packages/libs/fileAccess";
import { InputValidationError } from "../../packages/libs/inputValidation";

const roots: string[] = [];

function tempRoot(): string {
  const root: string = mkdtempSync(join(tmpdir(), "copy-ninjia-file-access-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("持久化路径的启动权限检查", () => {
  test("文件在可选检查与权限复核之间变得不可访问时仍返回安全输入错误", async () => {
    const root: string = tempRoot();
    const path: string = join(root, "state.json");
    await Bun.write(path, "{}");
    const parent = fs.lstatSync(root);
    const file = fs.lstatSync(path);
    const stat = spyOn(fs, "lstatSync")
      .mockReturnValueOnce(parent)
      .mockReturnValueOnce(file)
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("private_marker"), { code: "EACCES" });
      });
    try {
      expect(() => inspectOptionalFile(path)).toThrow(
        `${path}: $type must be an accessible filesystem entry.`
      );
    } finally {
      stat.mockRestore();
    }
  });

  test.each(["directory", "file"])("%s 的 EACCES 拒绝且不泄露底层错误", async (kind) => {
    const root: string = tempRoot();
    const path: string = kind === "file" ? join(root, "state.json") : root;
    if (kind === "file") await Bun.write(path, "{}");
    const originalAccess = fs.accessSync;
    const access = spyOn(fs, "accessSync").mockImplementation((target, mode) => {
      if (target === path) throw Object.assign(new Error("private_marker"), { code: "EACCES" });
      originalAccess(target, mode);
    });
    try {
      const inspect = (): boolean => kind === "file" ? inspectOptionalFile(path) : inspectOptionalDirectory(path);
      expect(inspect).toThrow(InputValidationError);
      expect(inspect).toThrow(`${path}: $mode must be `);
      expect(inspect).not.toThrow("private_marker");
    } finally {
      access.mockRestore();
    }
  });

  test("目录 stat 的 EACCES 不能被视为缺省", () => {
    const root: string = tempRoot();
    const stat = spyOn(fs, "lstatSync").mockImplementation(() => {
      throw Object.assign(new Error("private_marker"), { code: "EACCES" });
    });
    try {
      expect(() => inspectOptionalDirectory(root)).toThrow(
        `${root}: $type must be an accessible filesystem entry.`
      );
    } finally {
      stat.mockRestore();
    }
  });

  test("可选输入只有真正缺省才返回 false，缺省检查不创建目录", () => {
    const root: string = tempRoot();
    expect(inspectOptionalDirectory(join(root, "missing", "nested"))).toBe(false);
    expect(inspectOptionalFile(join(root, "missing", "nested", "state.json"))).toBe(false);
    expect(inspectOptionalDirectory(join(root, "missing"))).toBe(false);
  });

  test.each(["dangling", "loop", "file"])("缺省文件的祖先为 %s 时拒绝，不能被 ENOENT 掩盖", async (kind) => {
    const root: string = tempRoot();
    const ancestor: string = join(root, "memory");
    if (kind === "file") await Bun.write(ancestor, "private_marker");
    else symlinkSync(kind === "loop" ? ancestor : join(root, "missing"), ancestor);
    const leaf: string = join(ancestor, "domain", "state.json");
    expect(() => inspectOptionalFile(leaf)).toThrow(InputValidationError);
    expect(() => inspectOptionalDirectory(join(ancestor, "domain"))).toThrow(InputValidationError);
  });

  test("有效的领域目录链接沿用目录语义，叶子文件链接仍拒绝", async () => {
    const root: string = tempRoot();
    const actual: string = join(root, "actual");
    const linked: string = join(root, "linked");
    mkdirSync(actual);
    symlinkSync(actual, linked);
    await Bun.write(join(actual, "state.json"), "{}");
    expect(inspectOptionalDirectory(linked)).toBe(true);
    expect(inspectOptionalFile(join(linked, "state.json"))).toBe(true);
    symlinkSync(join(actual, "state.json"), join(root, "state.json"));
    expect(() => inspectOptionalFile(join(root, "state.json"))).toThrow(InputValidationError);
  });

  test("可读写的既有文件通过，不改动权限位", async () => {
    const root: string = tempRoot();
    const path: string = join(root, "state.json");
    await Bun.write(path, "{}", { mode: 0o600 });

    expect(() => assertFileReadableWritable(path)).not.toThrow();
  });

  test("文件不存在时以路径与字段路径拒绝，且不回显内容", () => {
    const root: string = tempRoot();
    const path: string = join(root, "missing.json");

    // accessSync 对缺失路径与权限不足抛的是同一类错误，本函数按同一条拒绝收口：
    // 「这条路径此刻不可读写」，不区分成因，也不替部署方创建。
    expect(() => assertFileReadableWritable(path)).toThrow(InputValidationError);
    expect(() => assertFileReadableWritable(path)).toThrow(
      `${path}: $mode must be readable and writable by the runtime account ` +
      "without changing the existing mode."
    );
  });

  test("目录与符号链接即使可读写也不能伪装成持久化普通文件", async () => {
    const root: string = tempRoot();
    const directoryPath: string = join(root, "state.json");
    const targetPath: string = join(root, "target.json");
    const linkPath: string = join(root, "linked.json");
    mkdirSync(directoryPath);
    await Bun.write(targetPath, "{}");
    symlinkSync(targetPath, linkPath);

    expect(() => assertFileReadableWritable(directoryPath)).toThrow(
      `${directoryPath}: $type must be a regular file without symbolic-link indirection.`
    );
    expect(() => assertFileReadableWritable(linkPath)).toThrow(
      `${linkPath}: $type must be a regular file without symbolic-link indirection.`
    );
  });

  test("可读写可进入的既有目录通过", () => {
    const root: string = tempRoot();
    const path: string = join(root, "database");
    mkdirSync(path, { mode: 0o700 });

    expect(() => assertDirectoryReadableWritable(path)).not.toThrow();
  });

  test("目录不存在时按「可读、可写、可进入」的期望形态拒绝", () => {
    const root: string = tempRoot();
    const path: string = join(root, "database");

    // SQLite 写连接要维护 WAL/SHM 旁路文件，因此父目录的期望形态比文件多一个
    // 可进入位（见 database/interact/connection.ts 的 requireWritableAccess）。
    expect(() => assertDirectoryReadableWritable(path)).toThrow(InputValidationError);
    expect(() => assertDirectoryReadableWritable(path)).toThrow(
      `${path}: $mode must be readable, writable and searchable by the runtime account.`
    );
  });

  test("错误信息只含路径、字段路径与期望形态，不含底层 errno 或文件内容", () => {
    const root: string = tempRoot();
    const secretPath: string = join(root, "g-auth.json");

    let message: string = "";
    try {
      assertFileReadableWritable(secretPath);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain(secretPath);
    expect(message).toContain("$mode");
    // 底层异常一律被吞掉：errno 文案进日志等于把部署方的目录结构写进 logs/。
    expect(message).not.toContain("ENOENT");
    expect(message).not.toContain("no such file");
  });
});
