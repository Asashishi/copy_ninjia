import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addProcessIo,
  diffProcessIo,
  emptyProcessIo,
  measureDirectoryFootprint,
  readProcessIo,
} from "../../scripts/perf/fullSuite/processIo";
import type {
  DirectoryFootprint,
  ProcessIoSnapshot,
} from "../../scripts/perf/fullSuite/processIo";
import type { ProcessIoDelta } from "../../scripts/perf/fullSuite/types";

function snapshot(base: number): ProcessIoSnapshot {
  return {
    rchar: base,
    wchar: base * 2,
    syscr: base * 3,
    syscw: base * 4,
    readBytes: base * 5,
    writeBytes: base * 6,
  };
}

describe("基准的读写计量", () => {
  test("读出的计数器全是有限数", () => {
    const io: ProcessIoSnapshot = readProcessIo();
    for (const value of Object.values(io)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  test("两次采样之差按字段对齐", () => {
    expect(diffProcessIo(snapshot(1), snapshot(3))).toEqual({
      rcharBytes: 2,
      wcharBytes: 4,
      readBytes: 10,
      writeBytes: 12,
      readSyscalls: 6,
      writeSyscalls: 8,
    });
  });

  test("计数器倒退时拒绝给出负的读写量", () => {
    expect((): ProcessIoDelta => diffProcessIo(snapshot(3), snapshot(1)))
      .toThrow("went backwards during the measured window");
  });

  test("零起点相加即逐项求和", () => {
    const first: ProcessIoDelta = diffProcessIo(snapshot(0), snapshot(1));
    const second: ProcessIoDelta = diffProcessIo(snapshot(0), snapshot(2));
    expect(addProcessIo(emptyProcessIo(), first)).toEqual(first);
    expect(addProcessIo(first, second)).toEqual({
      rcharBytes: 3,
      wcharBytes: 6,
      readBytes: 15,
      writeBytes: 18,
      readSyscalls: 9,
      writeSyscalls: 12,
    });
  });
});

describe("mock 根落盘足迹", () => {
  test("递归统计普通文件，跳过符号链接与目录本身", () => {
    const root: string = mkdtempSync(join(tmpdir(), "copy-ninjia-footprint-"));
    try {
      mkdirSync(join(root, "nested"));
      writeFileSync(join(root, "a.json"), "0123456789");
      writeFileSync(join(root, "nested", "b.json"), "01234");
      symlinkSync(join(root, "a.json"), join(root, "link.json"));
      const footprint: DirectoryFootprint = measureDirectoryFootprint(root);
      expect(footprint).toEqual({ bytes: 15, files: 2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("目录不存在时按空足迹返回，不让清理竞态变成失败", () => {
    expect(measureDirectoryFootprint(join(tmpdir(), "copy-ninjia-absent-root")))
      .toEqual({ bytes: 0, files: 0 });
  });
});
