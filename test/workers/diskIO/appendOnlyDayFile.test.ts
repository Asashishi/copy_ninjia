import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendToDayFile, openDayFile, serializeDayFileEntry } from "../../../src/workers/diskIO/appendOnlyDayFile";
import type { DayFileState } from "../../../src/types";

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

describe("appendOnlyDayFile：按位置追加的字节层机制", () => {
  test("文件不存在 -> openDayFile 视为空文件", () => {
    const state: DayFileState = openDayFile(dir, "2026-07-16");
    expect(state).toEqual({ day: "2026-07-16", size: 0, empty: true });
  });

  test("从空文件开始追加一条，结果是合法 JSON 且值正确", () => {
    const state: DayFileState = openDayFile(dir, "2026-07-16");
    const chunk: string = serializeDayFileEntry("111", { label: "大吉", fortunePercent: 90.12 });
    appendToDayFile(dir, state, chunk);

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
    appendToDayFile(dir, state, chunk);

    expect(readDay("2026-07-16")).toEqual({
      A: { label: "大吉", fortunePercent: 90.11 },
      B: { label: "小凶", fortunePercent: 39.99 },
      "C:所求事项": { label: "尚可", fortunePercent: 50 },
    });
  });

  test("多次独立 flush（跨多次 appendToDayFile 调用）累积追加，不覆盖已有内容", () => {
    const state: DayFileState = openDayFile(dir, "2026-07-16");
    appendToDayFile(dir, state, serializeDayFileEntry("A", { label: "大吉", fortunePercent: 90.11 }));
    appendToDayFile(dir, state, serializeDayFileEntry("B", { label: "吉", fortunePercent: 75 }));
    appendToDayFile(dir, state, serializeDayFileEntry("C", { label: "尚可", fortunePercent: 50 }));

    expect(readDay("2026-07-16")).toEqual({
      A: { label: "大吉", fortunePercent: 90.11 },
      B: { label: "吉", fortunePercent: 75 },
      C: { label: "尚可", fortunePercent: 50 },
    });
  });

  test("重新 openDayFile（模拟进程重启）读到已有单条记录后，继续追加不会破坏旧内容", () => {
    // 手工构造出与真实 memory/luck/2026-07-16.json 完全相同的字节内容
    const state1: DayFileState = openDayFile(dir, "2026-07-16");
    appendToDayFile(dir, state1, serializeDayFileEntry("8791894415", { label: "小凶", fortunePercent: 39.99 }));
    const raw: string = readFileSync(join(dir, "2026-07-16.json"), "utf8");
    expect(raw).toBe('{\n  "8791894415": {\n    "label": "小凶",\n    "fortunePercent": 39.99\n  }\n}');

    // 模拟重启：新的 DayFileState 通过重新探测磁盘现有文件得到
    const state2: DayFileState = openDayFile(dir, "2026-07-16");
    expect(state2.empty).toBe(false);
    appendToDayFile(dir, state2, serializeDayFileEntry("222", { label: "大凶", fortunePercent: 5 }));

    expect(readDay("2026-07-16")).toEqual({
      "8791894415": { label: "小凶", fortunePercent: 39.99 },
      "222": { label: "大凶", fortunePercent: 5 },
    });
  });

  test("多字节 UTF-8 字符（中文 label）不影响后续追加的字节位置计算", () => {
    const state: DayFileState = openDayFile(dir, "2026-07-16");
    // label 全部是多字节字符，用来暴露「按字符数而非字节数」计算位置的潜在 bug
    appendToDayFile(dir, state, serializeDayFileEntry("k1", { label: "大吉大利心想事成", fortunePercent: 90.12 }));
    appendToDayFile(dir, state, serializeDayFileEntry("k2", { label: "倒霉透顶诸事不宜", fortunePercent: 4.56 }));
    appendToDayFile(dir, state, serializeDayFileEntry("k3", { label: "普普通通", fortunePercent: 50.5 }));

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
      appendToDayFile(dir, state, serializeDayFileEntry(`user${i}`, { label: "小吉", fortunePercent: 60 + (i % 8) }));
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
    appendToDayFile(dir, state, serializeDayFileEntry("A", { label: "大吉", fortunePercent: 90.11 }));
    appendToDayFile(dir, state, serializeDayFileEntry("B", { label: "小凶", fortunePercent: 39.99 }));
    const full: string = readFileSync(join(dir, "2026-07-16.json"), "utf8");

    // 模拟断电：整份内容被截断在第二条记录中间（缺收尾的 "\n  }\n}"）
    const truncated: string = full.slice(0, full.indexOf('"B"') + 20);
    const path = join(dir, "2026-07-16.json");
    require("node:fs").writeFileSync(path, truncated);

    const recovered: DayFileState = openDayFile(dir, "2026-07-16");
    expect(recovered.empty).toBe(false);
    const parsedAfterRepair: unknown = readDay("2026-07-16");
    // 修复只保证「此前的完整记录」不丢；这里应恢复出 A。
    expect((parsedAfterRepair as any).A).toEqual({ label: "大吉", fortunePercent: 90.11 });

    // 修复后继续追加应仍能产出合法 JSON。
    appendToDayFile(dir, recovered, serializeDayFileEntry("C", { label: "尚可", fortunePercent: 50 }));
    expect((readDay("2026-07-16") as any).C).toEqual({ label: "尚可", fortunePercent: 50 });
  });
});
