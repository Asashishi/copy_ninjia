import { describe, expect, test } from "bun:test";
import { HOT_PATH_GC_WINDOW_END, HOT_PATH_GC_WINDOW_START } from "../../packages/consts/performance";
import { JSC_GC_LOG_ENV } from "../../packages/consts/environment";
import { summarizeGcPauseProfile } from "../../scripts/perf/hotPaths/gcProfile";

const HANDSHAKE: string = "[GC<0x123>: starting 0.03ms]\n";
const COLLECTION: string = "[GC<0x123>: START M 8832kb => EdenCollection, p=2ms (max 2), cycle 2ms END]\nGC END!\n";

function logWindow(body: string): string {
  return HANDSHAKE + COLLECTION + `${HOT_PATH_GC_WINDOW_START}\n${body}${HOT_PATH_GC_WINDOW_END} 100\n` + COLLECTION;
}

describe("JSC GC 暂停计量", () => {
  test("只统计正式窗口，包含并发收集切回前的每段暂停", () => {
    const concurrent: string = "[GC<0x123>: START M p=1ms (max 2)...]\n[GC<0x123>: C p=2ms (max 2), cycle 20ms END]\n";
    expect(summarizeGcPauseProfile(logWindow(COLLECTION + concurrent))).toEqual({
      elapsedMs: 100,
      pauseCount: 3,
      pauseMs: 5,
      gcPercent: 5,
    });
  });

  test("日志已启用且窗口没有 GC 时可以报告零", () => {
    expect(summarizeGcPauseProfile(logWindow(""))).toMatchObject({ pauseCount: 0, pauseMs: 0, gcPercent: 0 });
  });

  test("并发周期跨过测量边界时，只计窗口内实际暂停的阶段", () => {
    const resumed: string = "[GC<0x123>: M p=2ms (max 2), cycle 20ms END]\n";
    expect(summarizeGcPauseProfile(logWindow(resumed))).toMatchObject({ pauseCount: 1, pauseMs: 2, gcPercent: 2 });
  });

  test.each([
    logWindow(COLLECTION).replace(HANDSHAKE, ""),
    HANDSHAKE,
    logWindow(COLLECTION).replace(`${HOT_PATH_GC_WINDOW_END} 100`, `${HOT_PATH_GC_WINDOW_END} NaN`),
    logWindow(COLLECTION.replace("p=2ms", "p=unknownms")),
    logWindow("[GC<0x123>: START M\n"),
    logWindow(COLLECTION.replace("p=2ms", "p=200ms")),
    logWindow("") + HOT_PATH_GC_WINDOW_START,
  ])("未知或不完整日志必须失败：%#", (log: string) => {
    expect(() => summarizeGcPauseProfile(log)).toThrow();
  });

  test("真实分配触发的 GC 可被计量，不依赖函数名或强制 GC", async () => {
    const source: string = `
      import { beginGcProfileWindow, endGcProfileWindow } from ${JSON.stringify(new URL("../../scripts/perf/hotPaths/gcProfile.ts", import.meta.url).pathname)};
      const start = beginGcProfileWindow();
      let checksum = 0;
      for (let i = 0; i < 250_000; i++) checksum += JSON.parse('{"items":[1,2,3,4,5,6,7,8],"value":"abc"}').items.length;
      endGcProfileWindow(start);
      console.log(checksum);
    `;
    const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn([Bun.argv[0]!, "-e", source], {
      env: { ...process.env, [JSC_GC_LOG_ENV]: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const output: Promise<string> = child.stdout.text();
    const errors: Promise<string> = child.stderr.text();
    expect(await child.exited).toBe(0);
    expect((await output).trim()).toBe("2000000");
    const profile = summarizeGcPauseProfile(await errors);
    expect(profile.pauseCount).toBeGreaterThan(0);
    expect(profile.pauseMs).toBeGreaterThan(0);
    expect(profile.gcPercent).toBeGreaterThan(0);
  });
});
