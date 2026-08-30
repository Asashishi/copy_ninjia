import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { AD_SAMPLE_FILE_PATH, AD_SAMPLE_MEMORY_DIR } from "../../../packages/consts/paths";
import { AD_SAMPLE_FILE_MAX_BYTES, PERSISTED_FILE_MODE } from "../../../packages/consts/diskIO/common";
import {
  adSampleArchiveCursor,
  adSampleArchiveSweepDay,
  adSampleFileState,
  adSampleTempsSwept,
} from "../../../packages/cache/workers/diskIO/adSample";
import {
  handleAdSampleMessage,
  maintainAdSampleFiles,
  sweepExpiredAdSampleArchives,
} from "../../../packages/workers/diskIO/adSampleFile";
import type { AdSampleArchiveEntry } from "../../../packages/workers/diskIO/adSampleFile";
import type { AdSampleDiskMessage } from "../../../packages/types/diskIO";
import { getTokyoDateKey } from "../../../packages/libs/time";

function sample(overrides: Partial<AdSampleDiskMessage> = {}): AdSampleDiskMessage {
  return {
    type: "adSample",
    chatId: -1001,
    senderId: 7,
    label: "@spammer",
    detectedAt: "2026/07/28 11:44:01",
    reason: "引流加微信",
    messages: [
      { messageId: 11, text: "加我", replyTo: "在吗" },
      { messageId: 12, text: "微信 xxx", quote: "别人说过的话" },
    ],
    ...overrides,
  };
}

function readSamples(): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(AD_SAMPLE_FILE_PATH, "utf8")) as Record<string, Record<string, unknown>>;
}

beforeEach(() => {
  adSampleFileState.current = null;
  adSampleTempsSwept.current = false;
  adSampleArchiveSweepDay.current = null;
  adSampleArchiveCursor.current = null;
  rmSync(AD_SAMPLE_MEMORY_DIR, { recursive: true, force: true });
});

describe("广告命中样本旁路", () => {
  test("首条命中自建目录与文件，键是 chatId:首条 messageId", () => {
    handleAdSampleMessage(sample());

    const samples = readSamples();
    expect(Object.keys(samples)).toEqual(["-1001:11"]);
    expect(samples["-1001:11"]).toEqual({
      detectedAt: "2026/07/28 11:44:01",
      chatId: -1001,
      senderId: 7,
      label: "@spammer",
      reason: "引流加微信",
      // 判定看的是整串，样本因此按串记；引用/回复只在这里出现，判定读不到。
      messages: [
        { messageId: 11, text: "加我", replyTo: "在吗" },
        { messageId: 12, text: "微信 xxx", quote: "别人说过的话" },
      ],
    });
    expect(statSync(AD_SAMPLE_FILE_PATH).mode & 0o777).toBe(PERSISTED_FILE_MODE);
  });

  test("后续命中按位置追加，不整文件重写，旧条目原样保留", () => {
    handleAdSampleMessage(sample());
    handleAdSampleMessage(sample({
      chatId: -1002,
      senderId: 8,
      messages: [{ messageId: 21, text: "日入过千" }],
    }));

    const samples = readSamples();
    expect(Object.keys(samples)).toEqual(["-1001:11", "-1002:21"]);
    expect(samples["-1001:11"]?.reason).toBe("引流加微信");
  });

  test("被截断的旧文件按追加机制自愈，不阻塞新样本", () => {
    // 样本是可丢的旁路素材：断电撕裂了末尾那条就裁掉，与日志/运势同一档取舍。
    mkdirSync(AD_SAMPLE_MEMORY_DIR, { recursive: true });
    writeFileSync(AD_SAMPLE_FILE_PATH, '{\n  "-1001:1": {\n    "reason": "旧的"\n  },\n  "-1001:2": {\n    "rea');

    handleAdSampleMessage(sample());

    const samples = readSamples();
    expect(Object.keys(samples)).toEqual(["-1001:1", "-1001:11"]);
  });

  test("涨过上限就整份改名归档，新文件从空写起", () => {
    handleAdSampleMessage(sample());
    // 撑到上限：轮转判断在每次追加前跑，不是只在重新打开游标时跑。
    adSampleFileState.current = { size: AD_SAMPLE_FILE_MAX_BYTES, empty: false };
    const archivedBytes: string = readFileSync(AD_SAMPLE_FILE_PATH, "utf8");

    handleAdSampleMessage(sample({ messages: [{ messageId: 99, text: "换个号继续" }] }));

    // 新文件只剩轮转后的这一条。
    expect(Object.keys(readSamples())).toEqual(["-1001:99"]);
    // 当天新归档在 15 个东京自然日的保留窗口内，内容应原样保留。
    const archives: string[] = readdirSync(AD_SAMPLE_MEMORY_DIR)
      .filter((name: string): boolean => name !== "sample.json");
    expect(archives).toHaveLength(1);
    expect(readFileSync(join(AD_SAMPLE_MEMORY_DIR, archives[0]!), "utf8")).toBe(archivedBytes);
  });

  test("目录扫描缓存最小空缺归档序号，仍保持既有选名规则", () => {
    mkdirSync(AD_SAMPLE_MEMORY_DIR, { recursive: true });
    const today: string = getTokyoDateKey();
    writeFileSync(join(AD_SAMPLE_MEMORY_DIR, `sample.${today}.json`), "{}");
    writeFileSync(join(AD_SAMPLE_MEMORY_DIR, `sample.${today}.3.json`), "{}");
    writeFileSync(AD_SAMPLE_FILE_PATH, "{}");

    sweepExpiredAdSampleArchives({ today });
    expect(adSampleArchiveCursor.current).toEqual({ day: today, nextIndex: 2 });
    adSampleFileState.current = { size: AD_SAMPLE_FILE_MAX_BYTES, empty: true };
    handleAdSampleMessage(sample({ messages: [{ messageId: 99, text: "gap" }] }));

    expect(existsSync(join(AD_SAMPLE_MEMORY_DIR, `sample.${today}.2.json`))).toBeTrue();
  });

  test("归档只按严格文件名保留最近 15 个东京自然日，不误删当前文件、未知项或目录", () => {
    mkdirSync(AD_SAMPLE_MEMORY_DIR, { recursive: true });
    const removedNames: string[] = [
      "sample.2026-07-13.json",
      "sample.2026-07-13.2.json",
    ];
    const retainedNames: string[] = [
      "sample.json",
      "sample.2026-07-14.json",
      "sample.2026-07-27.3.json",
      "sample.2026-07-28.json",
      "sample.2026-02-31.json",
      "sample.2026-07-01.0.json",
      "sample.2026-07-01.02.json",
      "sample.other.json",
      ".sample.json.1234.abcd.tmp",
    ];
    for (const name of [...removedNames, ...retainedNames]) {
      writeFileSync(join(AD_SAMPLE_MEMORY_DIR, name), "{}");
    }
    const matchingDirectory: string = join(AD_SAMPLE_MEMORY_DIR, "sample.2026-07-01.4.json");
    mkdirSync(matchingDirectory);

    sweepExpiredAdSampleArchives({ today: "2026-07-28" });

    for (const name of removedNames) {
      expect(existsSync(join(AD_SAMPLE_MEMORY_DIR, name))).toBe(false);
    }
    for (const name of retainedNames) {
      expect(existsSync(join(AD_SAMPLE_MEMORY_DIR, name))).toBe(true);
    }
    expect(existsSync(matchingDirectory)).toBe(true);
  });

  test("归档清扫每天至多一次，单文件删除失败会继续且不阻塞样本追加", () => {
    const today: string = getTokyoDateKey();
    const entries: AdSampleArchiveEntry[] = [
      { name: "sample.2000-01-01.json", isFile: true },
      { name: "sample.2000-01-01.2.json", isFile: true },
    ];
    let listCalls: number = 0;
    const removed: string[] = [];
    const logError = spyOn(console, "error").mockImplementation((): void => {});
    const listEntries = (): AdSampleArchiveEntry[] => {
      listCalls += 1;
      return entries;
    };
    const removeFile = (path: string): void => {
      if (path.endsWith("sample.2000-01-01.json")) throw new Error("injected unlink failure");
      removed.push(path);
    };

    sweepExpiredAdSampleArchives({ today, listEntries, removeFile });
    sweepExpiredAdSampleArchives({ today, listEntries, removeFile });

    expect(listCalls).toBe(1);
    expect(removed).toHaveLength(1);
    expect(removed[0]?.endsWith("sample.2000-01-01.2.json")).toBe(true);
    expect(logError).toHaveBeenCalledTimes(1);
    handleAdSampleMessage(sample());
    expect(Object.keys(readSamples())).toEqual(["-1001:11"]);
    expect(listCalls).toBe(1);
    logError.mockRestore();
  });

  test("目录扫描失败也只记录一次，不阻塞同日样本追加", () => {
    const today: string = getTokyoDateKey();
    const logError = spyOn(console, "error").mockImplementation((): void => {});

    sweepExpiredAdSampleArchives({
      today,
      listEntries: (): AdSampleArchiveEntry[] => {
        throw new Error("injected readdir failure");
      },
    });
    handleAdSampleMessage(sample());

    expect(Object.keys(readSamples())).toEqual(["-1001:11"]);
    expect(logError).toHaveBeenCalledTimes(1);
    logError.mockRestore();
  });

  test("每日维护清掉孤儿临时文件与过期归档，但不创建尚未使用的目录", () => {
    maintainAdSampleFiles("2026-07-28");
    expect(existsSync(AD_SAMPLE_MEMORY_DIR)).toBeFalse();

    mkdirSync(AD_SAMPLE_MEMORY_DIR, { recursive: true });
    const orphan: string = join(AD_SAMPLE_MEMORY_DIR, ".sample.json.1234.abcd.tmp");
    const expired: string = join(AD_SAMPLE_MEMORY_DIR, "sample.2000-01-01.json");
    const retained: string = join(AD_SAMPLE_MEMORY_DIR, "sample.2026-07-28.json");
    writeFileSync(orphan, "{ partial");
    writeFileSync(expired, "{}");
    writeFileSync(retained, "{}");
    adSampleTempsSwept.current = false;

    maintainAdSampleFiles("2026-07-28");

    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(retained)).toBe(true);
  });

  test("写盘失败只作废游标、不抛出：旁路绝不能拖住封禁本身", () => {
    // 目录被占成普通文件，mkdir 必然失败。
    //
    // 父目录必须显式建出来：本用例要造的前置条件是「ad-detected 这个名字被一个
    // 普通文件占着」，而不是「memory/ 也不存在」。beforeEach 只删 ad-detected，
    // memory/ 一直是别的用例调 handleAdSampleMessage 时 recursive mkdir 顺带建的
    // ——`bun test --randomize` 把本用例排到文件里第一个时，writeFileSync 会先
    // 撞 ENOENT，用例还没开始就失败。
    mkdirSync(dirname(AD_SAMPLE_MEMORY_DIR), { recursive: true });
    rmSync(AD_SAMPLE_MEMORY_DIR, { recursive: true, force: true });
    writeFileSync(AD_SAMPLE_MEMORY_DIR, "not a directory");

    expect(() => handleAdSampleMessage(sample())).not.toThrow();
    expect(adSampleFileState.current).toBeNull();
    expect(existsSync(AD_SAMPLE_FILE_PATH)).toBe(false);

    rmSync(AD_SAMPLE_MEMORY_DIR, { force: true });
  });
});
