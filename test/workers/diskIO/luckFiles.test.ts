import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * mock.module 必须在任何真实 import 之前调用（理由同 test/commands/
 * luckChallenge.test.ts 的模块头注释）：snapshotFiles.ts 从 consts/paths
 * 取 LUCK_MEMORY_DIR，指向项目真实的 memory/luck/ 目录——单测里绝不能往
 * 那里写（会跟正在跑的 bot 进程并发读写同一批文件），整体重定向到临时目录。
 */
const luckDir: string = mkdtempSync(join(tmpdir(), "luck-files-test-"));
const realPaths = await import("../../../src/consts/paths");
mock.module("../../../src/consts/paths", () => ({ ...realPaths, LUCK_MEMORY_DIR: luckDir }));

const { flushLuckAppends, handleLuckDrawMessage } = await import("../../../src/workers/diskIO/luckFiles");
const { recoverLuckDay } = await import("../../../src/workers/diskIO/snapshotFiles");
const { luckFileState, luckFlushTimer, luckPendingAppends, luckWorkerCache } = await import("../../../src/cache/diskIOWorker");
const { FLUSH_MAX_ENTRIES } = await import("../../../src/consts/diskIO");
import type { LuckDrawDiskMessage } from "../../../src/types";

const DAY = "2026-07-16";

function luckMsg(key: string, label: string, fortunePercent: number, day: string = DAY): LuckDrawDiskMessage {
  return { type: "luckDraw", day, key, label, fortunePercent };
}

function readDayFile(day: string = DAY): Record<string, unknown> {
  return JSON.parse(readFileSync(join(luckDir, `${day}.json`), "utf8"));
}

function clearTimer(): void {
  if (luckFlushTimer.timer !== null) {
    clearTimeout(luckFlushTimer.timer);
    luckFlushTimer.timer = null;
  }
}

beforeEach(() => {
  rmSync(luckDir, { recursive: true, force: true });
  luckWorkerCache.current = null;
  luckPendingAppends.length = 0;
  luckFileState.current = null;
  clearTimer();
});

afterEach(() => {
  clearTimer();
});

describe("diskIO/luckFiles：运势缓冲/落盘调度", () => {
  test("新 key 入缓冲并排定时器，flush 后写入文件、缓冲清空", () => {
    handleLuckDrawMessage(luckMsg("111", "大吉", 90.12));
    expect(luckPendingAppends.length).toBe(1);
    expect(luckFlushTimer.timer).not.toBeNull();

    flushLuckAppends();
    expect(luckPendingAppends.length).toBe(0);
    expect(luckFlushTimer.timer).toBeNull();
    expect(readDayFile()).toEqual({ "111": { label: "大吉", fortunePercent: 90.12 } });
  });

  test("同 key 同值重放（Worker 崩溃重建后的全量重放）不重复入缓冲", () => {
    handleLuckDrawMessage(luckMsg("111", "大吉", 90.12));
    flushLuckAppends();

    handleLuckDrawMessage(luckMsg("111", "大吉", 90.12));
    expect(luckPendingAppends.length).toBe(0);
  });

  test("同 key 不同值（restoreLuckCache 丢弃旧记录后当天重抽）必须再次落盘，恢复时取最新值", () => {
    handleLuckDrawMessage(luckMsg("111", "大吉", 90.12));
    flushLuckAppends();

    // 模拟 LUCK_TIERS 改动后重启：主线程重抽出同 key 的新结果
    handleLuckDrawMessage(luckMsg("111", "小凶", 39.99));
    expect(luckPendingAppends.length).toBe(1);
    flushLuckAppends();

    // 文件里 key 出现两次（重复 key 追加是安全的），恢复语义取最后一次出现
    expect(readDayFile()).toEqual({ "111": { label: "小凶", fortunePercent: 39.99 } });
    const recovered = recoverLuckDay(DAY);
    expect(recovered?.entries.get("111")).toEqual({ label: "小凶", fortunePercent: 39.99 });
  });

  test("启动恢复先修复追加中断留下的尾部截断，保留此前完整运势", () => {
    mkdirSync(luckDir, { recursive: true });
    writeFileSync(join(luckDir, `${DAY}.json`), `{
  "111": {
    "label": "大吉",
    "fortunePercent": 90.12
  },
  "222": {
    "label": "写到一半`);

    const recovered = recoverLuckDay(DAY);

    expect(recovered?.entries.get("111")).toEqual({ label: "大吉", fortunePercent: 90.12 });
    expect(recovered?.entries.has("222")).toBe(false);
    expect(readDayFile()).toEqual({ "111": { label: "大吉", fortunePercent: 90.12 } });
    expect(existsSync(join(luckDir, `${DAY}.json.corrupt`))).toBe(false);
  });

  test("追加失败：缓冲保留、定时器重排、文件探测状态重置；故障排除后重试成功且不丢条目", () => {
    // 把当天文件位置占成一个目录，让 openDayFile 的 readFileSync 抛 EISDIR
    mkdirSync(join(luckDir, `${DAY}.json`), { recursive: true });
    handleLuckDrawMessage(luckMsg("111", "大吉", 90.12));
    flushLuckAppends();

    expect(luckPendingAppends.length).toBe(1); // 失败保留，等下轮重试
    expect(luckFlushTimer.timer).not.toBeNull(); // 重试不依赖下一条消息，定时器已重排
    expect(luckFileState.current).toBeNull(); // 下次重新探测/校验文件

    rmSync(join(luckDir, `${DAY}.json`), { recursive: true, force: true });
    flushLuckAppends();
    expect(luckPendingAppends.length).toBe(0);
    expect(readDayFile()).toEqual({ "111": { label: "大吉", fortunePercent: 90.12 } });
  });

  test("跨天：旧 day 的缓冲/去重集合/文件状态整体丢弃，只留新 day 的条目", () => {
    handleLuckDrawMessage(luckMsg("111", "大吉", 90.12, "2026-07-15"));
    expect(luckPendingAppends.length).toBe(1);

    handleLuckDrawMessage(luckMsg("222", "小凶", 39.99, DAY));
    expect(luckWorkerCache.current?.day).toBe(DAY);
    expect(luckPendingAppends.length).toBe(1);
    expect(luckPendingAppends[0]!.key).toBe("222");

    flushLuckAppends();
    expect(readDayFile()).toEqual({ "222": { label: "小凶", fortunePercent: 39.99 } });
    expect(existsSync(join(luckDir, "2026-07-15.json"))).toBe(false);
  });

  test("flush 后 cleanupStaleLuckFiles 顺带删除非当日文件", () => {
    handleLuckDrawMessage(luckMsg("111", "大吉", 90.12, "2026-07-15"));
    flushLuckAppends();
    expect(existsSync(join(luckDir, "2026-07-15.json"))).toBe(true);

    handleLuckDrawMessage(luckMsg("111", "大吉", 90.12, DAY));
    flushLuckAppends();
    expect(existsSync(join(luckDir, "2026-07-15.json"))).toBe(false);
    expect(existsSync(join(luckDir, `${DAY}.json`))).toBe(true);
  });

  test("条数达到 FLUSH_MAX_ENTRIES 立即落盘，不等定时器", () => {
    for (let i = 0; i < FLUSH_MAX_ENTRIES; i++) {
      handleLuckDrawMessage(luckMsg(`user${i}`, "小吉", 60));
    }
    // 最后一条触发了立即 flush：缓冲已清空，文件条目齐全
    expect(luckPendingAppends.length).toBe(0);
    expect(Object.keys(readDayFile()).length).toBe(FLUSH_MAX_ENTRIES);
  });
});
