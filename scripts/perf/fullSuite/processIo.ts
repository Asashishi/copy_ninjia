/**
 * 读写计量：进程级 `/proc/<pid>/io` 计数器与 mock 数据根的落盘足迹。
 *
 * 用 `/proc` 而不是在代码里数字节，是因为要计的正是**真实发生的** I/O：
 * SQLite 的 WAL、页写回、fsync 与 Bun 自身的文件读取都不经过项目代码，
 * 靠调用点累加只会得到一个偏小且随实现漂移的数。项目本就只支持带可读
 * `/proc` 的 Linux（见 README 的运行前提），这里不做跨平台回退。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Dirent, Stats } from "node:fs";
import type { ProcessIoDelta } from "./types";

/** 一次 `/proc/<pid>/io` 采样。字段名与内核输出的键一一对应。 */
export interface ProcessIoSnapshot {
  readonly rchar: number;
  readonly wchar: number;
  readonly syscr: number;
  readonly syscw: number;
  readonly readBytes: number;
  readonly writeBytes: number;
}

/** mock 数据根的落盘足迹。 */
export interface DirectoryFootprint {
  readonly bytes: number;
  readonly files: number;
}

const IO_KEYS: Readonly<Record<string, keyof ProcessIoSnapshot>> = {
  rchar: "rchar",
  wchar: "wchar",
  syscr: "syscr",
  syscw: "syscw",
  read_bytes: "readBytes",
  write_bytes: "writeBytes",
};

/** 采样当前进程的 I/O 计数器；解析失败按致命错误处理，不返回零值掩盖。 */
export function readProcessIo(): ProcessIoSnapshot {
  const content: string = readFileSync("/proc/self/io", "utf8");
  const values: Record<keyof ProcessIoSnapshot, number> = {
    rchar: Number.NaN,
    wchar: Number.NaN,
    syscr: Number.NaN,
    syscw: Number.NaN,
    readBytes: Number.NaN,
    writeBytes: Number.NaN,
  };
  for (const line of content.split("\n")) {
    const separator: number = line.indexOf(":");
    if (separator <= 0) continue;
    const field: keyof ProcessIoSnapshot | undefined =
      IO_KEYS[line.slice(0, separator)];
    if (field === undefined) continue;
    values[field] = Number(line.slice(separator + 1).trim());
  }
  for (const [field, value] of Object.entries(values)) {
    if (!Number.isFinite(value)) {
      throw new Error(`/proc/self/io did not report a finite ${field}.`);
    }
  }
  return values;
}

/** 两次采样之差；负数表示采样被计数器回绕污染，直接拒绝而不是报一个负的读写量。 */
export function diffProcessIo(
  before: ProcessIoSnapshot,
  after: ProcessIoSnapshot
): ProcessIoDelta {
  const delta: ProcessIoDelta = {
    rcharBytes: after.rchar - before.rchar,
    wcharBytes: after.wchar - before.wchar,
    readBytes: after.readBytes - before.readBytes,
    writeBytes: after.writeBytes - before.writeBytes,
    readSyscalls: after.syscr - before.syscr,
    writeSyscalls: after.syscw - before.syscw,
  };
  for (const [field, value] of Object.entries(delta)) {
    if (value < 0) {
      throw new Error(`Process I/O counter ${field} went backwards during the measured window.`);
    }
  }
  return delta;
}

/** 逐项相加；父进程用它把各子进程的读写汇总成一轮的总量。 */
export function addProcessIo(
  left: ProcessIoDelta,
  right: ProcessIoDelta
): ProcessIoDelta {
  return {
    rcharBytes: left.rcharBytes + right.rcharBytes,
    wcharBytes: left.wcharBytes + right.wcharBytes,
    readBytes: left.readBytes + right.readBytes,
    writeBytes: left.writeBytes + right.writeBytes,
    readSyscalls: left.readSyscalls + right.readSyscalls,
    writeSyscalls: left.writeSyscalls + right.writeSyscalls,
  };
}

/** 全零增量，作为求和起点。 */
export function emptyProcessIo(): ProcessIoDelta {
  return {
    rcharBytes: 0,
    wcharBytes: 0,
    readBytes: 0,
    writeBytes: 0,
    readSyscalls: 0,
    writeSyscalls: 0,
  };
}

/** 递归统计目录足迹；符号链接不跟随，按 0 字节记，避免统计到根外的文件。 */
export function measureDirectoryFootprint(root: string): DirectoryFootprint {
  let bytes: number = 0;
  let files: number = 0;
  const pending: string[] = [root];
  while (pending.length > 0) {
    const directory: string = pending.pop()!;
    let entries: readonly Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path: string = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      files += 1;
      try {
        const stats: Stats = statSync(path);
        bytes += stats.size;
      } catch {
        continue;
      }
    }
  }
  return { bytes, files };
}
