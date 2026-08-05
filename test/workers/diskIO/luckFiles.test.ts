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
const realPaths = await import("../../../packages/consts/paths");
mock.module("../../../packages/consts/paths", () => ({ ...realPaths, LUCK_MEMORY_DIR: luckDir }));

const {
  configureLuckAppendStalledReply,
  flushLuckAppends,
  handleLuckDrawMessage,
  hydrateLuckDay,
  retryLuckFlush,
} = await import("../../../packages/workers/diskIO/luckFiles");
const { recoverLuckDay } = await import("../../../packages/workers/diskIO/snapshotFiles");
const {
  luckAppendFailures,
  luckAppendStalledNotifier,
  luckDeferredDraws,
  luckFileState,
  luckFlushTimer,
  luckPendingAppends,
  luckWorkerCache,
  resetLuckCache,
} = await import("../../../packages/cache/workers/diskIO/luck");
const {
  FLUSH_MAX_ENTRIES,
  LUCK_APPEND_STALL_ALERT_FAILURES,
  LUCK_DEFERRED_DRAW_MAX,
} = await import("../../../packages/consts/diskIO");
import type { LuckAppendStalledReply, LuckDrawDiskMessage } from "../../../packages/types";

const DAY = "2026-07-16";

function luckMsg({
  key,
  label,
  fortunePercent,
  day = DAY,
}: {
  key: string;
  label: string;
  fortunePercent: number;
  day?: string;
}): LuckDrawDiskMessage {
  return { type: "luckDraw", day, key, label, fortunePercent };
}

function readDayFile(day: string = DAY): Record<string, unknown> {
  return JSON.parse(readFileSync(join(luckDir, `${day}.json`), "utf8"));
}

beforeEach(() => {
  rmSync(luckDir, { recursive: true, force: true });
  resetLuckCache();
  luckAppendStalledNotifier.current = null;
});

afterEach(() => {
  resetLuckCache();
  luckAppendStalledNotifier.current = null;
});

/** 把当日文件位置占成目录，让 openDayFile 的 readFileSync 恒抛 EISDIR。 */
function breakDayFile(day: string = DAY): void {
  mkdirSync(join(luckDir, `${day}.json`), { recursive: true });
}

/** 解除上面那道人造故障。 */
function repairDayFile(day: string = DAY): void {
  rmSync(join(luckDir, `${day}.json`), { recursive: true, force: true });
}

/**
 * 立刻跑一次排着的那个重试定时器该做的事，不必真等 FLUSH_INTERVAL_MS（30 秒）。
 * 定时器本身要先 clearTimeout 掉，否则它到点还会再跑一次、落进后面的用例里。
 */
function fireLuckFlushTimer(): void {
  expect(luckFlushTimer.timer).not.toBeNull();
  clearTimeout(luckFlushTimer.timer!);
  retryLuckFlush();
}

describe("diskIO/luckFiles：运势缓冲/落盘调度", () => {
  test("新 key 入缓冲并排定时器，flush 后写入文件、缓冲清空", () => {
    handleLuckDrawMessage(luckMsg({ key: "111", label: "大吉", fortunePercent: 90.12 }));
    expect(luckPendingAppends.length).toBe(1);
    expect(luckFlushTimer.timer).not.toBeNull();

    expect(flushLuckAppends()).toBeTrue();
    expect(luckPendingAppends.length).toBe(0);
    expect(luckFlushTimer.timer).toBeNull();
    expect(readDayFile()).toEqual({ "111": { label: "大吉", fortunePercent: 90.12 } });
  });

  test("同 key 同值重放（Worker 崩溃重建后的全量重放）不重复入缓冲", () => {
    handleLuckDrawMessage(luckMsg({ key: "111", label: "大吉", fortunePercent: 90.12 }));
    expect(flushLuckAppends()).toBeTrue();

    handleLuckDrawMessage(luckMsg({ key: "111", label: "大吉", fortunePercent: 90.12 }));
    expect(luckPendingAppends.length).toBe(0);
  });

  test("同 key 不同值（restoreLuckState 丢弃旧记录后当天重派生）必须再次落盘，恢复时取最新值", () => {
    handleLuckDrawMessage(luckMsg({ key: "111", label: "大吉", fortunePercent: 90.12 }));
    flushLuckAppends();

    // 模拟 LUCK_TIERS 改动后重启：主线程为同 key 派生出按新档位表解释的结果
    handleLuckDrawMessage(luckMsg({ key: "111", label: "小凶", fortunePercent: 39.99 }));
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

  test("启动恢复遇到不兼容结构时阻止启动，不改写当天文件或清理旧日", () => {
    mkdirSync(luckDir, { recursive: true });
    const todayPath: string = join(luckDir, `${DAY}.json`);
    const stalePath: string = join(luckDir, "2026-07-15.json");
    const original: string = "[{\"bad\":\"shape\"}]";
    writeFileSync(todayPath, original);
    writeFileSync(stalePath, "{}");

    expect(() => recoverLuckDay(DAY)).toThrow("must contain a top-level JSON object");
    expect(readFileSync(todayPath, "utf8")).toBe(original);
    expect(existsSync(`${todayPath}.corrupt`)).toBe(false);
    expect(existsSync(stalePath)).toBe(true);
  });

  test("启动恢复遇到非法运势记录时阻止启动并保持原文件不变", () => {
    mkdirSync(luckDir, { recursive: true });
    const path: string = join(luckDir, `${DAY}.json`);
    const original: string = JSON.stringify({
      "111": { label: 123, fortunePercent: 90.12 },
    }, null, 2);
    writeFileSync(path, original);

    expect(() => recoverLuckDay(DAY)).toThrow("contains an invalid luck record for key 111");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("追加失败：缓冲保留、定时器重排、文件探测状态重置；故障排除后重试成功且不丢条目", () => {
    // 把当天文件位置占成一个目录，让 openDayFile 的 readFileSync 抛 EISDIR
    mkdirSync(join(luckDir, `${DAY}.json`), { recursive: true });
    handleLuckDrawMessage(luckMsg({ key: "111", label: "大吉", fortunePercent: 90.12 }));
    expect(flushLuckAppends()).toBeFalse();

    expect(luckPendingAppends.length).toBe(1); // 失败保留，等下轮重试
    expect(luckFlushTimer.timer).not.toBeNull(); // 重试不依赖下一条消息，定时器已重排
    expect(luckFileState.current).toBeNull(); // 下次重新探测/校验文件

    rmSync(join(luckDir, `${DAY}.json`), { recursive: true, force: true });
    expect(flushLuckAppends()).toBeTrue();
    expect(luckPendingAppends.length).toBe(0);
    expect(readDayFile()).toEqual({ "111": { label: "大吉", fortunePercent: 90.12 } });
  });

  test("跨天：旧 day 尚未刷的缓冲先落盘再切，之后运行态整体换成新 day", () => {
    handleLuckDrawMessage(luckMsg({ key: "111", label: "大吉", fortunePercent: 90.12, day: "2026-07-15" }));
    expect(luckPendingAppends.length).toBe(1);

    handleLuckDrawMessage(luckMsg({ key: "222", label: "小凶", fortunePercent: 39.99, day: DAY }));
    // startLuckDay 会把 luckPendingAppends 整个清零；不先刷盘，那条 2026-07-15
    // 的已确认结果就一次都没写盘地静默消失了。
    expect(readDayFile("2026-07-15")).toEqual({ "111": { label: "大吉", fortunePercent: 90.12 } });
    expect(luckWorkerCache.current?.day).toBe(DAY);
    expect(luckPendingAppends.length).toBe(1);
    expect(luckPendingAppends[0]!.key).toBe("222");

    flushLuckAppends();
    expect(readDayFile()).toEqual({ "222": { label: "小凶", fortunePercent: 39.99 } });
    // 当日 flush 之后的 cleanupStaleLuckFiles 才回收旧日文件。
    expect(existsSync(join(luckDir, "2026-07-15.json"))).toBe(false);
  });

  test("跨天刷盘失败时拒绝切日：宁可拒掉新日消息，也不拿旧日条目换 owner", () => {
    handleLuckDrawMessage(luckMsg({ key: "111", label: "大吉", fortunePercent: 90.12, day: "2026-07-15" }));
    // 把旧日文件位置占成目录，让 openDayFile 的 readFileSync 抛 EISDIR。
    mkdirSync(join(luckDir, "2026-07-15.json"), { recursive: true });

    handleLuckDrawMessage(luckMsg({ key: "222", label: "小凶", fortunePercent: 39.99, day: DAY }));

    expect(luckWorkerCache.current?.day).toBe("2026-07-15");
    expect(luckPendingAppends.length).toBe(1);
    expect(luckPendingAppends[0]!.key).toBe("111");

    // 故障排除后旧日照常刷盘，条目一条都没丢。
    rmSync(join(luckDir, "2026-07-15.json"), { recursive: true, force: true });
    expect(flushLuckAppends()).toBeTrue();
    expect(readDayFile("2026-07-15")).toEqual({ "111": { label: "大吉", fortunePercent: 90.12 } });
  });

  test("恢复当天文件后重放昨日消息会丢弃旧消息，不倒退缓存或误删当天文件", () => {
    handleLuckDrawMessage(luckMsg({ key: "222", label: "小凶", fortunePercent: 39.99, day: DAY }));
    expect(flushLuckAppends()).toBeTrue();
    resetLuckCache();
    hydrateLuckDay(DAY);

    handleLuckDrawMessage(luckMsg({
      key: "111",
      label: "大吉",
      fortunePercent: 90.12,
      day: "2026-07-15",
    }));

    expect(luckWorkerCache.current?.day).toBe(DAY);
    expect(luckPendingAppends).toEqual([]);
    expect(flushLuckAppends()).toBeTrue();
    expect(readDayFile()).toEqual({ "222": { label: "小凶", fortunePercent: 39.99 } });
    expect(existsSync(join(luckDir, "2026-07-15.json"))).toBe(false);
  });

  test("flush 后 cleanupStaleLuckFiles 顺带删除非当日文件", () => {
    handleLuckDrawMessage(luckMsg({ key: "111", label: "大吉", fortunePercent: 90.12, day: "2026-07-15" }));
    flushLuckAppends();
    expect(existsSync(join(luckDir, "2026-07-15.json"))).toBe(true);

    handleLuckDrawMessage(luckMsg({ key: "111", label: "大吉", fortunePercent: 90.12, day: DAY }));
    flushLuckAppends();
    expect(existsSync(join(luckDir, "2026-07-15.json"))).toBe(false);
    expect(existsSync(join(luckDir, `${DAY}.json`))).toBe(true);
  });

  test("条数达到 FLUSH_MAX_ENTRIES 立即落盘，不等定时器", () => {
    for (let i = 0; i < FLUSH_MAX_ENTRIES; i++) {
      handleLuckDrawMessage(luckMsg({ key: `user${i}`, label: "小吉", fortunePercent: 60 }));
    }
    // 最后一条触发了立即 flush：缓冲已清空，文件条目齐全
    expect(luckPendingAppends.length).toBe(0);
    expect(Object.keys(readDayFile()).length).toBe(FLUSH_MAX_ENTRIES);
  });
});

describe("diskIO/luckFiles：追加持续失败的停摆诊断", () => {
  test("连续失败到阈值才发一条诊断，之前只累计不告警", () => {
    const alerts: LuckAppendStalledReply[] = [];
    configureLuckAppendStalledReply((reply: LuckAppendStalledReply): void => { alerts.push(reply); });
    handleLuckDrawMessage(luckMsg({ key: "111", label: "大吉", fortunePercent: 90.12 }));
    breakDayFile();

    for (let i = 1; i < LUCK_APPEND_STALL_ALERT_FAILURES; i++) {
      expect(flushLuckAppends()).toBeFalse();
      expect(alerts).toEqual([]);
      expect(luckAppendFailures.consecutive).toBe(i);
    }

    expect(flushLuckAppends()).toBeFalse();
    expect(alerts.length).toBe(1);
    const alert: LuckAppendStalledReply = alerts[0]!;
    expect(alert.type).toBe("luckAppendStalled");
    expect(alert.day).toBe(DAY);
    // 条目还压在 Worker 内存里——这正是主线程 dailyLuckCache 有、磁盘没有的那批。
    expect(alert.pendingEntries).toBe(1);
    expect(alert.consecutiveFailures).toBe(LUCK_APPEND_STALL_ALERT_FAILURES);
    expect(alert.error.length).toBeGreaterThan(0);
  });

  test("同一故障期内继续失败不重复告警（边沿触发，不刷爆 logs/）", () => {
    const alerts: LuckAppendStalledReply[] = [];
    configureLuckAppendStalledReply((reply: LuckAppendStalledReply): void => { alerts.push(reply); });
    handleLuckDrawMessage(luckMsg({ key: "111", label: "大吉", fortunePercent: 90.12 }));
    breakDayFile();

    for (let i = 0; i < LUCK_APPEND_STALL_ALERT_FAILURES * 3; i++) flushLuckAppends();

    expect(alerts.length).toBe(1);
    expect(luckAppendFailures.consecutive).toBe(LUCK_APPEND_STALL_ALERT_FAILURES * 3);
  });

  test("恢复后重新武装：下一次故障期会再告警一次", () => {
    const alerts: LuckAppendStalledReply[] = [];
    configureLuckAppendStalledReply((reply: LuckAppendStalledReply): void => { alerts.push(reply); });
    handleLuckDrawMessage(luckMsg({ key: "111", label: "大吉", fortunePercent: 90.12 }));
    breakDayFile();
    for (let i = 0; i < LUCK_APPEND_STALL_ALERT_FAILURES; i++) flushLuckAppends();
    expect(alerts.length).toBe(1);

    // 故障排除：条目一条不丢地补写进去，计数与告警标记一起归零。
    repairDayFile();
    expect(flushLuckAppends()).toBeTrue();
    expect(readDayFile()).toEqual({ "111": { label: "大吉", fortunePercent: 90.12 } });
    expect(luckAppendFailures.consecutive).toBe(0);
    expect(luckAppendFailures.alerted).toBeFalse();

    // 第二次故障期照常告警。
    handleLuckDrawMessage(luckMsg({ key: "222", label: "小凶", fortunePercent: 39.99 }));
    repairDayFile();
    breakDayFile();
    for (let i = 0; i < LUCK_APPEND_STALL_ALERT_FAILURES; i++) flushLuckAppends();
    expect(alerts.length).toBe(2);
    expect(alerts[1]!.consecutiveFailures).toBe(LUCK_APPEND_STALL_ALERT_FAILURES);
  });

  test("诊断出口未装上时不算已告警：装上之后同一故障期仍会报出来", () => {
    handleLuckDrawMessage(luckMsg({ key: "111", label: "大吉", fortunePercent: 90.12 }));
    breakDayFile();
    for (let i = 0; i < LUCK_APPEND_STALL_ALERT_FAILURES; i++) {
      expect(flushLuckAppends()).toBeFalse();
    }
    expect(luckAppendFailures.alerted).toBeFalse();

    const alerts: LuckAppendStalledReply[] = [];
    configureLuckAppendStalledReply((reply: LuckAppendStalledReply): void => { alerts.push(reply); });
    expect(flushLuckAppends()).toBeFalse();
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.consecutiveFailures).toBe(LUCK_APPEND_STALL_ALERT_FAILURES + 1);
  });

  test("诊断投递自己抛出时不逸出：落盘线程不被一行告警拖垮，且不算已告警", () => {
    let throwOnNotify: boolean = true;
    const alerts: LuckAppendStalledReply[] = [];
    configureLuckAppendStalledReply((reply: LuckAppendStalledReply): void => {
      if (throwOnNotify) throw new Error("worker is terminating");
      alerts.push(reply);
    });
    handleLuckDrawMessage(luckMsg({ key: "111", label: "大吉", fortunePercent: 90.12 }));
    breakDayFile();

    for (let i = 0; i < LUCK_APPEND_STALL_ALERT_FAILURES; i++) {
      // 异常被吞在诊断分支里：flushLuckAppends 照常返回 false，不向上抛。
      expect(flushLuckAppends()).toBeFalse();
    }
    expect(alerts).toEqual([]);
    expect(luckAppendFailures.alerted).toBeFalse();

    // 投递恢复后同一故障期仍会报出来。
    throwOnNotify = false;
    expect(flushLuckAppends()).toBeFalse();
    expect(alerts.length).toBe(1);
  });

  test("旧日刷不动时拒绝换 owner，但新一天的抽签滞留待补录而不是被丢掉", () => {
    // 主线程的 dailyLuckCache 已经把这条记成「今天抽过了」并发了回执：直接丢掉
    // 的话，磁盘恢复后当天文件永远缺它，用户当天也再抽不了第二次，而
    // onDiskIORespawn 的全量重放只覆盖 Worker 重建，覆盖不到「Worker 活着但
    // 写不进盘」这条路径。
    handleLuckDrawMessage(luckMsg({ key: "111", label: "大吉", fortunePercent: 90.12 }));
    breakDayFile();

    // 东京零点：新一天的第一条抽签到达，旧日刷盘失败。
    handleLuckDrawMessage(luckMsg({ key: "222", label: "凶", fortunePercent: 10.5, day: "2026-07-17" }));
    expect(luckWorkerCache.current?.day).toBe(DAY);
    expect(luckDeferredDraws.length).toBe(1);
    // 旧日的条目一条都没丢，仍等着重试。
    expect(luckPendingAppends.length).toBe(1);

    // 故障期内继续有人抽，同样滞留。
    handleLuckDrawMessage(luckMsg({ key: "333", label: "吉", fortunePercent: 55, day: "2026-07-17" }));
    expect(luckDeferredDraws.length).toBe(2);

    // 磁盘恢复：旧日先落盘，随后 owner 换到新一天并把滞留的两条补录进去。
    repairDayFile();
    handleLuckDrawMessage(luckMsg({ key: "444", label: "中吉", fortunePercent: 70, day: "2026-07-17" }));
    expect(luckWorkerCache.current?.day).toBe("2026-07-17");
    expect(luckDeferredDraws.length).toBe(0);
    expect(readDayFile(DAY)).toEqual({ "111": { label: "大吉", fortunePercent: 90.12 } });

    expect(flushLuckAppends()).toBeTrue();
    expect(readDayFile("2026-07-17")).toEqual({
      "222": { label: "凶", fortunePercent: 10.5 },
      "333": { label: "吉", fortunePercent: 55 },
      "444": { label: "中吉", fortunePercent: 70 },
    });
  });

  test("重试定时器自己刷成功时就补录，不必等下一条抽签来推", () => {
    // 运势是每人每天一次的低频写入：靠「下一条 luckDraw」来推动补录的话，磁盘
    // 早就恢复了，滞留的条目却可能还要在内存里再躺几个小时，甚至今天再也没有
    // 下一条。这里直接触发那个重试定时器的回调，验证它自己会把滞留区排空。
    handleLuckDrawMessage(luckMsg({ key: "111", label: "大吉", fortunePercent: 90.12 }));
    breakDayFile();
    handleLuckDrawMessage(luckMsg({ key: "222", label: "凶", fortunePercent: 10.5, day: "2026-07-17" }));
    expect(luckDeferredDraws.length).toBe(1);

    repairDayFile();
    fireLuckFlushTimer();

    expect(luckDeferredDraws.length).toBe(0);
    expect(luckWorkerCache.current?.day).toBe("2026-07-17");
    expect(readDayFile(DAY)).toEqual({ "111": { label: "大吉", fortunePercent: 90.12 } });
    expect(flushLuckAppends()).toBeTrue();
    expect(readDayFile("2026-07-17")).toEqual({ "222": { label: "凶", fortunePercent: 10.5 } });
  });

  test("滞留区有上界：满了丢最旧的一条并记一行，绝不静默", () => {
    handleLuckDrawMessage(luckMsg({ key: "000", label: "大吉", fortunePercent: 90.12 }));
    breakDayFile();

    for (let i = 0; i < LUCK_DEFERRED_DRAW_MAX + 2; i++) {
      handleLuckDrawMessage(luckMsg({ key: `k${i}`, label: "吉", fortunePercent: i, day: "2026-07-17" }));
    }

    expect(luckDeferredDraws.length).toBe(LUCK_DEFERRED_DRAW_MAX);
    // 丢的是最旧的两条，留下的是最近的一批。
    expect(luckDeferredDraws[0]?.key).toBe("k2");
    expect(luckDeferredDraws.at(-1)?.key).toBe(`k${LUCK_DEFERRED_DRAW_MAX + 1}`);
  });

  test("换 owner 会连同滞留区一起清空：hydrate 之后没有跨日残留", () => {
    handleLuckDrawMessage(luckMsg({ key: "111", label: "大吉", fortunePercent: 90.12 }));
    breakDayFile();
    handleLuckDrawMessage(luckMsg({ key: "222", label: "凶", fortunePercent: 10.5, day: "2026-07-17" }));
    expect(luckDeferredDraws.length).toBe(1);

    // 启动恢复整体替换 owner：滞留区属于上一任 owner 的运行态，不能跨过去。
    repairDayFile();
    hydrateLuckDay("2026-07-17");
    expect(luckDeferredDraws.length).toBe(0);
  });

  test("跨日整体换 owner 时失败计数归零：旧 owner 的失败不算在新 owner 头上", () => {
    handleLuckDrawMessage(luckMsg({ key: "111", label: "大吉", fortunePercent: 90.12 }));
    breakDayFile();
    for (let i = 0; i < LUCK_APPEND_STALL_ALERT_FAILURES; i++) flushLuckAppends();
    expect(luckAppendFailures.consecutive).toBe(LUCK_APPEND_STALL_ALERT_FAILURES);

    repairDayFile();
    hydrateLuckDay("2026-07-17");
    expect(luckAppendFailures.consecutive).toBe(0);
    expect(luckAppendFailures.alerted).toBeFalse();
  });
});
