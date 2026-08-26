import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendToDayFile,
  openAppendOnlyFile,
  openDayFile,
  serializeDayFileEntry,
} from "../../../packages/workers/diskIO/appendOnlyDayFile";
import { PERSISTED_FILE_MODE } from
  "../../../packages/consts/diskIO/common";
import type { DayFileState } from "../../../packages/types";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "luck-append-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readDay(day: string): unknown {
  return JSON.parse(readFileSync(join(dir, `${day}.json`), "utf8"));
}

/** 仅验证明确选择截断修复的通用追加机制；领域状态恢复默认 fail closed。 */
function openRepairableDay(day: string): DayFileState {
  return { day, ...openAppendOnlyFile(join(dir, `${day}.json`), undefined, true) };
}

describe("appendOnlyDayFile：按位置追加的字节层机制", () => {
  test("新建文件使用 0644，接管时保留部署方已有的 0600", () => {
    const previousUmask: number = process.umask(0o077);
    try {
      const state: DayFileState = openDayFile(dir, "2026-07-16", PERSISTED_FILE_MODE);
      appendToDayFile({ dir, state, chunk: serializeDayFileEntry("a", 1), mode: PERSISTED_FILE_MODE });
    } finally {
      process.umask(previousUmask);
    }
    const path: string = join(dir, "2026-07-16.json");
    expect(statSync(path).mode & 0o777).toBe(0o644);

    chmodSync(path, 0o600);
    openDayFile(dir, "2026-07-16", PERSISTED_FILE_MODE);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("文件不存在 -> openDayFile 视为空文件", () => {
    const state: DayFileState = openDayFile(dir, "2026-07-16");
    expect(state).toEqual({ day: "2026-07-16", size: 0, empty: true });
  });

  test("非对象顶层 JSON 会阻止接管并保持原始字节不变", () => {
    const path: string = join(dir, "2026-07-16.json");
    for (const content of ["[]", "[{\"bad\":\"shape\"}]", "null", "\"text\"", "42"]) {
      writeFileSync(path, content);

      expect(() => openDayFile(dir, "2026-07-16")).toThrow("must contain a top-level JSON object");
      expect(readFileSync(path, "utf8")).toBe(content);
    }
  });

  test("无法修复的语法损坏会阻止接管并保持原始字节不变", () => {
    const path: string = join(dir, "2026-07-16.json");
    const content: string = "not-json";
    writeFileSync(path, content);

    expect(() => openDayFile(dir, "2026-07-16")).toThrow("could not be parsed; refusing to repair this file");
    expect(readFileSync(path, "utf8")).toBe(content);
  });

  test("从空文件开始追加一条，结果是合法 JSON 且值正确", () => {
    const state: DayFileState = openDayFile(dir, "2026-07-16");
    const chunk: string = serializeDayFileEntry("111", { label: "大吉", fortunePercent: 90.12 });
    appendToDayFile({ dir, state, chunk });

    expect(readDay("2026-07-16")).toEqual({ "111": { label: "大吉", fortunePercent: 90.12 } });
    expect(state.empty).toBe(false);
  });

  test("单次 flush 内追加多条（逗号拼接的 chunk）：全部条目完整存在", () => {
    const state: DayFileState = openDayFile(dir, "2026-07-16");
    const chunk: string = [
      serializeDayFileEntry("A", { label: "大吉", fortunePercent: 90.11 }),
      serializeDayFileEntry("B", { label: "小凶", fortunePercent: 39.99 }),
      serializeDayFileEntry("C:所求事项", { label: "尚可", fortunePercent: 50 }),
    ].join(",\n");
    appendToDayFile({ dir, state, chunk });

    expect(readDay("2026-07-16")).toEqual({
      A: { label: "大吉", fortunePercent: 90.11 },
      B: { label: "小凶", fortunePercent: 39.99 },
      "C:所求事项": { label: "尚可", fortunePercent: 50 },
    });
  });

  test("多次独立 flush（跨多次 appendToDayFile 调用）累积追加，不覆盖已有内容", () => {
    const state: DayFileState = openDayFile(dir, "2026-07-16");
    appendToDayFile({ dir, state, chunk: serializeDayFileEntry("A", { label: "大吉", fortunePercent: 90.11 }) });
    appendToDayFile({ dir, state, chunk: serializeDayFileEntry("B", { label: "吉", fortunePercent: 75 }) });
    appendToDayFile({ dir, state, chunk: serializeDayFileEntry("C", { label: "尚可", fortunePercent: 50 }) });

    expect(readDay("2026-07-16")).toEqual({
      A: { label: "大吉", fortunePercent: 90.11 },
      B: { label: "吉", fortunePercent: 75 },
      C: { label: "尚可", fortunePercent: 50 },
    });
  });

  test("底层分段 short write 会循环到完整 Buffer 后才推进游标", () => {
    const state: DayFileState = openDayFile(dir, "2026-07-16");
    appendToDayFile({ dir, state, chunk: serializeDayFileEntry("A", { label: "大吉" }) });
    const writes: number[] = [];

    appendToDayFile({
      dir,
      state,
      chunk: serializeDayFileEntry("B", { label: "小吉" }),
      write: ({ fd, buffer, offset, length, position }) => {
        const bytes: number = Math.min(3, length);
        writes.push(bytes);
        return writeSync(fd, buffer, offset, bytes, position);
      },
    });

    expect(writes.length).toBeGreaterThan(1);
    expect(readDay("2026-07-16")).toEqual({ A: { label: "大吉" }, B: { label: "小吉" } });
    expect(state.size).toBe(statSync(join(dir, "2026-07-16.json")).size);
  });

  test("已有文件的追加在成功返回前只执行一次 fsync，且顺序晚于完整 write", () => {
    const state: DayFileState = openDayFile(dir, "2026-07-16");
    appendToDayFile({ dir, state, chunk: serializeDayFileEntry("A", 1) });
    const calls: string[] = [];

    appendToDayFile({
      dir,
      state,
      chunk: serializeDayFileEntry("B", 2),
      write: (request) => {
        calls.push("write");
        return writeSync(request.fd, request.buffer, request.offset, request.length, request.position);
      },
      sync: () => { calls.push("sync"); },
    });

    expect(calls).toEqual(["write", "sync"]);
    expect(readDay("2026-07-16")).toEqual({ A: 1, B: 2 });
  });

  test("fsync 失败按追加失败上抛、重新探测游标并关闭 fd", () => {
    const state: DayFileState = openDayFile(dir, "2026-07-16");
    appendToDayFile({ dir, state, chunk: serializeDayFileEntry("A", 1) });
    let capturedFd: number | null = null;

    expect(() => appendToDayFile({
      dir,
      state,
      chunk: serializeDayFileEntry("B", 2),
      sync: (fd) => {
        capturedFd = fd;
        throw new Error("injected fsync failure");
      },
    })).toThrow("injected fsync failure");

    expect(state.size).toBe(statSync(join(dir, "2026-07-16.json")).size);
    expect(() => writeSync(capturedFd!, Buffer.from("x"), 0, 1, 0)).toThrow();
    appendToDayFile({ dir, state, chunk: serializeDayFileEntry("C", 3) });
    expect(readDay("2026-07-16")).toEqual({ A: 1, B: 2, C: 3 });
  });

  test("零字节写显式失败，不虚增 offset，并关闭文件描述符", () => {
    const state: DayFileState = openDayFile(dir, "2026-07-16");
    appendToDayFile({ dir, state, chunk: serializeDayFileEntry("A", 1) });
    const originalSize: number = state.size;
    let capturedFd: number | null = null;

    expect(() => appendToDayFile({
      dir,
      state,
      chunk: serializeDayFileEntry("B", 2),
      write: ({ fd }) => {
        capturedFd = fd;
        return 0;
      },
    })).toThrow("made no valid progress");

    expect(state.size).toBe(originalSize);
    expect(readDay("2026-07-16")).toEqual({ A: 1 });
    expect(() => writeSync(capturedFd!, Buffer.from("x"), 0, 1, 0)).toThrow();
  });

  test("中途写异常会重新探测并修复文件，后续 append 不从虚假 offset 开始", () => {
    const state: DayFileState = openDayFile(dir, "2026-07-16");
    appendToDayFile({ dir, state, chunk: serializeDayFileEntry("A", { value: 1 }) });
    let call: number = 0;

    expect(() => appendToDayFile({
      dir,
      state,
      chunk: serializeDayFileEntry("B", { payload: "会被截断" }),
      repair: true,
      write: ({ fd, buffer, offset, length, position }) => {
        call++;
        if (call > 1) throw new Error("injected I/O failure");
        const bytes: number = Math.min(8, length);
        return writeSync(fd, buffer, offset, bytes, position);
      },
    })).toThrow("injected I/O failure");

    expect(readDay("2026-07-16")).toEqual({ A: { value: 1 } });
    expect(state.size).toBe(statSync(join(dir, "2026-07-16.json")).size);
    appendToDayFile({ dir, state, chunk: serializeDayFileEntry("C", 3) });
    expect(readDay("2026-07-16")).toEqual({ A: { value: 1 }, C: 3 });
  });

  test("重新 openDayFile（模拟进程重启）读到已有单条记录后，继续追加不会破坏旧内容", () => {
    // 手工构造出与真实 memory/luck/2026-07-16.json 完全相同的字节内容
    const state1: DayFileState = openDayFile(dir, "2026-07-16");
    appendToDayFile({ dir, state: state1, chunk: serializeDayFileEntry("8791894415", { label: "小凶", fortunePercent: 39.99 }) });
    const raw: string = readFileSync(join(dir, "2026-07-16.json"), "utf8");
    expect(raw).toBe('{\n  "8791894415": {\n    "label": "小凶",\n    "fortunePercent": 39.99\n  }\n}');

    // 模拟重启：新的 DayFileState 通过重新探测磁盘现有文件得到
    const state2: DayFileState = openDayFile(dir, "2026-07-16");
    expect(state2.empty).toBe(false);
    appendToDayFile({ dir, state: state2, chunk: serializeDayFileEntry("222", { label: "大凶", fortunePercent: 5 }) });

    expect(readDay("2026-07-16")).toEqual({
      "8791894415": { label: "小凶", fortunePercent: 39.99 },
      "222": { label: "大凶", fortunePercent: 5 },
    });
  });

  test("多字节 UTF-8 字符（中文 label）不影响后续追加的字节位置计算", () => {
    const state: DayFileState = openDayFile(dir, "2026-07-16");
    // label 全部是多字节字符，用来暴露「按字符数而非字节数」计算位置的潜在 bug
    appendToDayFile({ dir, state, chunk: serializeDayFileEntry("k1", { label: "大吉大利心想事成", fortunePercent: 90.12 }) });
    appendToDayFile({ dir, state, chunk: serializeDayFileEntry("k2", { label: "倒霉透顶诸事不宜", fortunePercent: 4.56 }) });
    appendToDayFile({ dir, state, chunk: serializeDayFileEntry("k3", { label: "普普通通", fortunePercent: 50.5 }) });

    expect(readDay("2026-07-16")).toEqual({
      k1: { label: "大吉大利心想事成", fortunePercent: 90.12 },
      k2: { label: "倒霉透顶诸事不宜", fortunePercent: 4.56 },
      k3: { label: "普普通通", fortunePercent: 50.5 },
    });
    // state.size 全程只靠算术更新、从不重新 statSync；这里额外校验它确实
    // 跟物理文件字节数（而非字符数）保持一致。
    const physicalSize: number = Buffer.byteLength(readFileSync(join(dir, "2026-07-16.json"), "utf8"));
    expect(state.size).toBe(physicalSize);
  });

  test("大批量条目（超过 FLUSH_MAX_ENTRIES 量级）连续追加，全部完整且顺序无关", () => {
    const state: DayFileState = openDayFile(dir, "2026-07-16");
    const total = 500;
    for (let i = 0; i < total; i++) {
      appendToDayFile({ dir, state, chunk: serializeDayFileEntry(`user${i}`, { label: "小吉", fortunePercent: 60 + (i % 8) }) });
    }
    const result: Record<string, unknown> = readDay("2026-07-16") as Record<string, unknown>;
    expect(Object.keys(result).length).toBe(total);
    expect(result.user0).toEqual({ label: "小吉", fortunePercent: 60 });
    expect(result.user499).toEqual({ label: "小吉", fortunePercent: 63 });
  });

  test("serializeDayFileEntry 输出的分片拼起来后与 JSON.stringify(整份对象, null, 2) 逐字节一致", () => {
    const obj = {
      A: { label: "大吉", fortunePercent: 90.11 },
      B: { label: "小凶", fortunePercent: 39.99 },
    };
    const viaEntries: string = `{\n${Object.entries(obj)
      .map(([k, v]) => serializeDayFileEntry(k, v))
      .join(",\n")}\n}`;
    expect(viaEntries).toBe(JSON.stringify(obj, null, 2));
  });

  test("截断修复：断电截断在最后一条记录中间时，能裁掉残片并保留此前的完整记录", () => {
    const state: DayFileState = openDayFile(dir, "2026-07-16");
    appendToDayFile({ dir, state, chunk: serializeDayFileEntry("A", { label: "大吉", fortunePercent: 90.11 }) });
    appendToDayFile({ dir, state, chunk: serializeDayFileEntry("B", { label: "小凶", fortunePercent: 39.99 }) });
    const full: string = readFileSync(join(dir, "2026-07-16.json"), "utf8");

    // 模拟断电：整份内容被截断在第二条记录中间（缺收尾的 "\n  }\n}"）
    const truncated: string = full.slice(0, full.indexOf('"B"') + 20);
    const path = join(dir, "2026-07-16.json");
    writeFileSync(path, truncated);

    const recovered: DayFileState = openRepairableDay("2026-07-16");
    expect(recovered.empty).toBe(false);
    const parsedAfterRepair: unknown = readDay("2026-07-16");
    // 截断恢复必须保留残片之前的完整记录 A。
    expect((parsedAfterRepair as any).A).toEqual({ label: "大吉", fortunePercent: 90.11 });

    // 修复后继续追加应仍能产出合法 JSON。
    appendToDayFile({ dir, state: recovered, chunk: serializeDayFileEntry("C", { label: "尚可", fortunePercent: 50 }) });
    expect((readDay("2026-07-16") as any).C).toEqual({ label: "尚可", fortunePercent: 50 });
  });

  test("截断修复：重复 key 的 null tombstone 后发生撕裂时，保留 tombstone 作为最后值", () => {
    const state: DayFileState = openDayFile(dir, "2026-07-16");
    appendToDayFile({ dir, state, chunk: serializeDayFileEntry("K", { revision: 1 }) });
    appendToDayFile({ dir, state, chunk: serializeDayFileEntry("R", { revision: 1 }) });
    appendToDayFile({ dir, state, chunk: serializeDayFileEntry("K", null) });
    appendToDayFile({ dir, state, chunk: serializeDayFileEntry("N", { revision: 1, payload: "会被截断" }) });

    const path: string = join(dir, "2026-07-16.json");
    const full: string = readFileSync(path, "utf8");
    const tornEntryStart: number = full.lastIndexOf('"N"');
    writeFileSync(path, full.slice(0, tornEntryStart + 20));

    const recovered: DayFileState = openRepairableDay("2026-07-16");
    expect(readDay("2026-07-16")).toEqual({ K: null, R: { revision: 1 } });

    appendToDayFile({ dir, state: recovered, chunk: serializeDayFileEntry("C", true) });
    expect(readDay("2026-07-16")).toEqual({ K: null, R: { revision: 1 }, C: true });
  });

  test("截断修复：早期成员损坏后仍只保留损坏前的最后有效前缀", () => {
    const path: string = join(dir, "2026-07-16.json");
    const later: string[] = [];
    for (let index: number = 0; index < 4_000; index++) {
      later.push(`  "later-${index}": {"value": ${index}}`);
    }
    const original: string =
      `{\n  "valid": {"value": 1},\n  "bad": truX,\n${later.join(",\n")},\n  "torn":`;
    writeFileSync(path, original);

    const recovered: DayFileState = openRepairableDay("2026-07-16");
    expect(recovered.empty).toBeFalse();
    expect(readDay("2026-07-16")).toEqual({ valid: { value: 1 } });
  });

  test("截断修复：断电截断发生在第一条记录写入之前（文件只剩一个 \"{\"），修复出的空对象要被正确判成 empty，" +
    "否则下一次追加会误判成「非空、按位置追加」写出非法 JSON（回归：曾导致这条记录永久丢失的级联损坏）", () => {
    const path = join(dir, "2026-07-16.json");
    writeFileSync(path, "{");

    const recovered: DayFileState = openRepairableDay("2026-07-16");
    expect(recovered.empty).toBe(true);
    expect(readDay("2026-07-16")).toEqual({});

    // empty 置位后，下一次追加必须走「整份覆写」分支并产出合法 JSON；
    // 对 3 字节残片按非空文件追加会生成打头带逗号的非法 JSON。
    appendToDayFile({ dir, state: recovered, chunk: serializeDayFileEntry("111", { label: "大吉", fortunePercent: 90.12 }) });
    expect(readDay("2026-07-16")).toEqual({ "111": { label: "大吉", fortunePercent: 90.12 } });

    // 再模拟一次重启，确认新记录在磁盘上完整且可再次解析。
    const state3: DayFileState = openDayFile(dir, "2026-07-16");
    expect(state3.empty).toBe(false);
    appendToDayFile({ dir, state: state3, chunk: serializeDayFileEntry("222", { label: "小吉", fortunePercent: 60 }) });
    expect(readDay("2026-07-16")).toEqual({
      "111": { label: "大吉", fortunePercent: 90.12 },
      "222": { label: "小吉", fortunePercent: 60 },
    });
  });
});
