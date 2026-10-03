import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  formatLocalTime,
  getCurrentTime,
  getDayIndex,
  formatLogTimestamp,
  getDateKey,
  getDayStartTimestamp,
  getLocalHour,
} from "../../packages/libs/time";
import type { CurrentTimeResult } from "../../packages/types/time";
import { adoptTimeZone, getTimeZone } from "../../packages/config/time";
import { DAY_MS } from "../../packages/consts/diskIO/common";

const INITIAL_TIME_ZONE: string = getTimeZone();
beforeEach((): void => { adoptTimeZone("Asia/Tokyo"); });
afterEach((): void => { adoptTimeZone(INITIAL_TIME_ZONE); });

/**
 * formatLocalTime 与 Intl 参照实现逐字符对拍；拼接顺序与补零
 * 规则必须保持一致。
 */
const REFERENCE_FORMATTER: Intl.DateTimeFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function reference(timestampMs: number): string {
  return REFERENCE_FORMATTER.format(timestampMs);
}

describe("libs/time formatLocalTime", () => {
  test("形态就是转录行与落盘用的那一种", () => {
    // 2025-10-09T08:53:20Z = 东京 17:53:20
    expect(formatLocalTime(1_760_000_000_000)).toBe("2025/10/09 17:53:20");
    expect(formatLocalTime(1_760_000_000_000)).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test("与 Intl 参照实现在 1970-2100 均匀采样上逐字符一致", () => {
    const end: number = Date.UTC(2100, 0, 1);
    for (let i: number = 0; i < 20_000; i++) {
      const ms: number = Math.floor((i / 20_000) * end);
      expect(formatLocalTime(ms)).toBe(reference(ms));
    }
  });

  test("与 Intl 参照实现在伪随机散点上逐字符一致", () => {
    const end: number = Date.UTC(2100, 0, 1);
    let state: number = 987_654_321;
    for (let i: number = 0; i < 20_000; i++) {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      const ms: number = Math.floor((state / 0x1_0000_0000) * end);
      expect(formatLocalTime(ms)).toBe(reference(ms));
    }
  });

  test("跨秒、跨分、跨小时、跨日、闰日与年末边界逐毫秒一致", () => {
    const anchors: readonly number[] = [
      // 东京的一天从 UTC 前一天 15:00 开始，跨日边界必须落在这里。
      Date.UTC(2026, 0, 1, 14, 59, 59, 999),
      Date.UTC(2026, 0, 1, 15, 0, 0, 0),
      // 闰年 2 月末
      Date.UTC(2024, 1, 28, 15, 0, 0, 0),
      Date.UTC(2024, 1, 29, 14, 59, 59, 999),
      // 年末跨年
      Date.UTC(2025, 11, 31, 14, 59, 59, 999),
      Date.UTC(2025, 11, 31, 15, 0, 0, 0),
      // 纪元原点附近
      0,
    ];
    for (const anchor of anchors) {
      for (let delta: number = -1_500; delta <= 1_500; delta++) {
        const ms: number = anchor + delta;
        expect(formatLocalTime(ms)).toBe(reference(ms));
      }
    }
  });

  test("同一秒内的不同毫秒产出同一个串（格式精度到秒）", () => {
    const base: number = Date.UTC(2026, 5, 1, 3, 4, 5, 0);
    expect(formatLocalTime(base)).toBe(formatLocalTime(base + 999));
    expect(formatLocalTime(base + 1_000)).not.toBe(formatLocalTime(base));
  });

  test("历史夏令时按 IANA 规则格式化", () => {
    const duringJapaneseDst: number = Date.UTC(1950, 6, 1, 3, 0, 0);
    expect(formatLocalTime(duringJapaneseDst)).toBe(reference(duringJapaneseDst));
    expect(reference(duringJapaneseDst)).toBe("1950/07/01 13:00:00");
  });
});

describe("libs/time getDayIndex", () => {
  test("只在配置时区的零点推进日序并拒绝非法时间戳", () => {
    const beforeMidnight: number = Date.UTC(2026, 7, 30, 14, 59, 59, 999);
    const midnight: number = beforeMidnight + 1;
    expect(getDayIndex(beforeMidnight - 60_000)).toBe(
      getDayIndex(beforeMidnight)
    );
    expect(getDayIndex(midnight - 1) + 1).toBe(getDayIndex(midnight));
    expect(() => getDayIndex(-1)).toThrow("non-negative safe integer");
    expect(() => getDayIndex(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      "non-negative safe integer"
    );
  });

  test("本地日 UTC 起点在零点推进，超出原生时间范围时拒绝", () => {
    const beforeMidnight: number = Date.UTC(2026, 7, 30, 14, 59, 59, 999);
    const midnight: number = beforeMidnight + 1;
    expect(getDayStartTimestamp(beforeMidnight))
      .toBe(Date.UTC(2026, 7, 29, 15));
    expect(getDayStartTimestamp(midnight)).toBe(midnight);
    const maximumTimestamp: number = 8_640_000_000_000_000;
    const maximumStart: number = getDayStartTimestamp(maximumTimestamp);
    expect(Number.isSafeInteger(maximumStart)).toBeTrue();
    expect(maximumStart).toBeLessThanOrEqual(maximumTimestamp);
    expect(maximumTimestamp - maximumStart).toBeLessThan(24 * 60 * 60 * 1_000);
    expect(() => getDayStartTimestamp(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
  });
});

/**
 * getCurrentTime 拼进**每一次**模型请求：回复链路进 user 内容的运行时状态区块
 * （workers/aiChat/runtimeState.ts），压缩链路进 userContent
 * （workers/aiChat/compaction.ts）；getLocalHour 是心情分档的输入。
 */
describe("libs/time getCurrentTime 与 getLocalHour", () => {
  test("三个字段齐备，时区来自配置，iso 可被解析回同一时刻", () => {
    const before: number = Date.now();
    const current: CurrentTimeResult = getCurrentTime();
    const after: number = Date.now();

    expect(current.timezone).toBe(getTimeZone());
    const parsed: number = Date.parse(current.iso);
    expect(parsed).toBeGreaterThanOrEqual(before - 1_000);
    expect(parsed).toBeLessThanOrEqual(after + 1_000);
    // formatted 是给模型读的配置时区的时间全量描述，不能是空串或 ISO 串本身。
    expect(current.formatted.length).toBeGreaterThan(0);
    expect(current.formatted).not.toBe(current.iso);
  });

  test("formatted 与 iso 指向同一时刻的东京日历日", () => {
    const current: CurrentTimeResult = getCurrentTime();
    const tokyoDay: string = formatLocalTime(Date.parse(current.iso)).slice(0, 10);
    const [year, month, day]: string[] = tokyoDay.split("/");
    // zh-CN dateStyle:"full" 输出形如「2026年1月15日星期四」，逐段核对而不是
    // 整串比较：不同 ICU 版本的分隔符与星期写法会变，年月日不会。
    expect(current.formatted).toContain(`${Number(year)}年`);
    expect(current.formatted).toContain(`${Number(month)}月`);
    expect(current.formatted).toContain(`${Number(day)}日`);
  });

  test("getLocalHour 恒在 0~23，与 Intl 参照一致且 1970 前归一", () => {
    for (const utcHour of [0, 8, 14, 15, 23]) {
      const timestampMs: number = Date.UTC(2026, 0, 15, utcHour, 30, 0);
      const hour: number = getLocalHour(timestampMs);
      expect(hour).toBe((utcHour + 9) % 24);
      expect(hour).toBe(Number(HOUR_REFERENCE_FORMATTER.format(timestampMs)));
    }
    expect(getLocalHour(Date.UTC(1969, 11, 31, 20, 0, 0))).toBe(5);
    const now: number = Date.now();
    const hour: number = getLocalHour();
    expect([getLocalHour(now), getLocalHour(now + 3_600_000)]).toContain(hour);
  });
});

const DATE_KEY_REFERENCE_FORMATTER: Intl.DateTimeFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const HOUR_REFERENCE_FORMATTER: Intl.DateTimeFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Tokyo",
  hourCycle: "h23",
  hour: "numeric",
});

const LOG_TIMESTAMP_REFERENCE_FORMATTER: Intl.DateTimeFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hour12: false,
});

function referenceLogTimestamp(timestampMs: number): string {
  const parts: Record<string, string> = {};
  for (const part of LOG_TIMESTAMP_REFERENCE_FORMATTER.formatToParts(timestampMs)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return `${parts.year}-${parts.month}-${parts.day} ` +
    `${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}`;
}

/** 1970-2100 均匀采样、伪随机散点与跨日/闰日/年末各 ±1500 ms 逐毫秒的时间戳。 */
function sampledTimestamps(): readonly number[] {
  const end: number = Date.UTC(2100, 0, 1);
  const samples: number[] = [];
  let state: number = 123_456_789;
  for (let i: number = 0; i < 10_000; i++) {
    samples.push(Math.floor((i / 10_000) * end));
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    samples.push(Math.floor((state / 0x1_0000_0000) * end));
  }
  for (const anchor of [
    Date.UTC(2026, 0, 1, 15, 0, 0, 0),
    Date.UTC(2024, 1, 29, 15, 0, 0, 0),
    Date.UTC(2025, 11, 31, 15, 0, 0, 0),
  ]) {
    for (let delta: number = -1_500; delta <= 1_500; delta++) samples.push(anchor + delta);
  }
  return samples;
}

describe("libs/time getDateKey 与 formatLogTimestamp", () => {
  test("形态与缺省参数", () => {
    expect(getDateKey(1_760_000_000_000)).toBe("2025-10-09");
    expect(formatLogTimestamp(1_760_000_000_007)).toBe("2025-10-09 17:53:20.007");
    expect(formatLogTimestamp(1_760_000_000_070)).toBe("2025-10-09 17:53:20.070");
    expect(formatLogTimestamp(1_760_000_000_700)).toBe("2025-10-09 17:53:20.700");
    const before: string = getDateKey(Date.now());
    const current: string = getDateKey();
    expect([before, getDateKey(Date.now())]).toContain(current);
  });

  test("与 Intl 参照实现逐字符一致", () => {
    for (const timestampMs of sampledTimestamps()) {
      expect(getDateKey(timestampMs)).toBe(DATE_KEY_REFERENCE_FORMATTER.format(timestampMs));
      expect(formatLogTimestamp(timestampMs)).toBe(referenceLogTimestamp(timestampMs));
    }
  });
});

test("配置时区影响日期、时间、日志前缀、小时及模型报时", (): void => {
  adoptTimeZone("Asia/Kathmandu");
  const timestamp: number = Date.parse("2026-08-30T18:30:00.123Z");
  expect(getDateKey(timestamp)).toBe("2026-08-31");
  expect(formatLocalTime(timestamp)).toBe("2026/08/31 00:15:00");
  expect(formatLogTimestamp(timestamp)).toBe("2026-08-31 00:15:00.123");
  expect(getLocalHour(timestamp)).toBe(0);
  expect(getDayStartTimestamp(timestamp)).toBe(Date.parse("2026-08-30T18:15:00Z"));
  expect(getCurrentTime().timezone).toBe(getTimeZone());
});

test("夏令时切换日的日界与序号不依赖固定 UTC 偏移或 24 小时日长", (): void => {
  adoptTimeZone("America/New_York");
  const springStart: number = Date.parse("2026-03-08T05:00:00Z");
  const springNext: number = Date.parse("2026-03-09T04:00:00Z");
  expect(getDayStartTimestamp(springNext - 1)).toBe(springStart);
  expect(getDayIndex(springStart) + 1).toBe(getDayIndex(springNext));
  expect(formatLocalTime(Date.parse("2026-03-08T07:00:00Z"))).toBe("2026/03/08 03:00:00");
  const fallStart: number = Date.parse("2026-11-01T04:00:00Z");
  const fallNext: number = Date.parse("2026-11-02T05:00:00Z");
  expect(getDayStartTimestamp(fallNext - 1)).toBe(fallStart);
  expect(getDayIndex(fallStart) + 1).toBe(getDayIndex(fallNext));
  expect(formatLocalTime(Date.parse("2026-11-01T05:30:00Z"))).toBe("2026/11/01 01:30:00");
  expect(formatLocalTime(Date.parse("2026-11-01T06:30:00Z"))).toBe("2026/11/01 01:30:00");
});

test("零点被夏令时跳过时，自然日从当日首个真实时刻开始", (): void => {
  adoptTimeZone("America/Sao_Paulo");
  const start: number = Date.parse("2018-11-04T03:00:00Z");
  expect(formatLocalTime(start)).toBe("2018/11/04 01:00:00");
  expect(getDayStartTimestamp(start + 1_000)).toBe(start);
  expect(getDateKey(start - 1)).toBe("2018-11-03");
  expect(getDayIndex(start)).toBe(getDayIndex(start - 1) + 1);
});

/** 偏移区段缓存的对拍时区：固定偏移、半小时与 45 分偏移、半小时夏令时、负夏令时与历史 LMT。 */
const SEGMENT_TIME_ZONES: readonly string[] = [
  "Asia/Tokyo", "UTC", "America/New_York", "Europe/Dublin", "Australia/Lord_Howe",
  "Pacific/Chatham", "Africa/Casablanca", "Asia/Kolkata", "America/Sao_Paulo", "Asia/Kathmandu",
];

/** 逐次进入 Temporal 的参照实现；与区段缓存版本逐字段对拍。 */
function temporalReference(timestampMs: number, timeZone: string): readonly [string, string, string, number, number | null] {
  const local: Temporal.ZonedDateTime = Temporal.Instant.fromEpochMilliseconds(timestampMs).toZonedDateTimeISO(timeZone);
  return [
    local.toPlainDate().toString(),
    local.toPlainDateTime().toString({ fractionalSecondDigits: 0 }).replaceAll("-", "/").replace("T", " "),
    local.toString({ timeZoneName: "never", offset: "never", calendarName: "never", fractionalSecondDigits: 3 }).replace("T", " "),
    local.hour,
    timestampMs < 0 ? null : Math.floor((timestampMs + local.offsetNanoseconds / 1_000_000) / DAY_MS),
  ];
}

function cachedResult(timestampMs: number): readonly [string, string, string, number, number | null] {
  return [
    getDateKey(timestampMs),
    formatLocalTime(timestampMs),
    formatLogTimestamp(timestampMs),
    getLocalHour(timestampMs),
    timestampMs < 0 ? null : getDayIndex(timestampMs),
  ];
}

/** 1900–2100 内某时区的全部规则转换点（epoch 毫秒，升序）。 */
function transitionsOf(timeZone: string): readonly number[] {
  const end: number = Date.UTC(2100, 0, 1);
  const points: number[] = [];
  let cursor: Temporal.ZonedDateTime | null = Temporal.Instant.fromEpochMilliseconds(Date.UTC(1900, 0, 1)).toZonedDateTimeISO(timeZone);
  while (cursor !== null) {
    cursor = cursor.getTimeZoneTransition("next");
    if (cursor === null || cursor.epochMilliseconds >= end) break;
    points.push(cursor.epochMilliseconds);
  }
  return points;
}

describe("libs/time UTC 偏移区段缓存", () => {
  test.each([...SEGMENT_TIME_ZONES])("%s：1900–2100 采样与 Temporal 参照逐字段一致", (timeZone: string) => {
    adoptTimeZone(timeZone);
    const start: number = Date.UTC(1900, 0, 1);
    const span: number = Date.UTC(2100, 0, 1) - start;
    let state: number = 246_813_579;
    for (let i: number = 0; i < 2_000; i++) {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      for (const timestampMs of [start + Math.floor((i / 2_000) * span), start + Math.floor((state / 0x1_0000_0000) * span)]) {
        expect(cachedResult(timestampMs)).toEqual(temporalReference(timestampMs, timeZone));
      }
    }
  });

  test.each([...SEGMENT_TIME_ZONES])("%s：每个转换点的前后 1 ms 正序、逆序与交替访问都一致", (timeZone: string) => {
    adoptTimeZone(timeZone);
    const points: readonly number[] = transitionsOf(timeZone);
    for (const point of points) {
      for (const timestampMs of [point - 1, point, point + 1]) {
        expect(cachedResult(timestampMs)).toEqual(temporalReference(timestampMs, timeZone));
      }
    }
    for (let index: number = points.length - 1; index >= 0; index--) {
      const point: number = points[index]!;
      for (const timestampMs of [point + 1, point, point - 1]) {
        expect(cachedResult(timestampMs)).toEqual(temporalReference(timestampMs, timeZone));
      }
    }
    for (const point of [...points.slice(0, 5), ...points.slice(-40)]) {
      for (const timestampMs of [point - 3_600_000, point + 3_600_000, point - 1, point, point - 3_600_000]) {
        expect(cachedResult(timestampMs)).toEqual(temporalReference(timestampMs, timeZone));
      }
    }
  });

  test("格式化定义域两端仍是四位年份，越界、NaN 与小数抛 RangeError", () => {
    for (const timeZone of ["Pacific/Kiritimati", "Etc/GMT+12", "Asia/Tokyo"]) {
      adoptTimeZone(timeZone);
      const low: number = Date.UTC(1000, 0, 2);
      const high: number = Date.UTC(9999, 11, 30, 23, 59, 59, 999);
      for (const timestampMs of [low, high]) {
        expect(cachedResult(timestampMs)).toEqual(temporalReference(timestampMs, timeZone));
        expect(getDateKey(timestampMs)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
    for (const invalid of [Number.NaN, 1.5, Number.POSITIVE_INFINITY, Date.UTC(10_000, 0, 1), Date.UTC(999, 11, 31)]) {
      expect(() => getDateKey(invalid)).toThrow(RangeError);
      expect(() => formatLocalTime(invalid)).toThrow(RangeError);
      expect(() => formatLogTimestamp(invalid)).toThrow(RangeError);
    }
    for (const invalid of [Number.NaN, 0.5, 8_640_000_000_000_001, -8_640_000_000_000_001]) {
      expect(() => getLocalHour(invalid)).toThrow(RangeError);
    }
    expect(getLocalHour(8_640_000_000_000_000)).toBe(
      Temporal.Instant.fromEpochMilliseconds(8_640_000_000_000_000).toZonedDateTimeISO("Asia/Tokyo").hour
    );
    expect(() => getDayIndex(0.5)).toThrow(RangeError);
  });

  test("换时区后区段随状态整体重建，同名时区沿用已有区段", () => {
    const timestampMs: number = Date.UTC(2026, 6, 1, 20, 0, 0);
    adoptTimeZone("Asia/Tokyo");
    expect(getDateKey(timestampMs)).toBe("2026-07-02");
    adoptTimeZone("America/New_York");
    expect(getDateKey(timestampMs)).toBe("2026-07-01");
    expect(formatLocalTime(timestampMs)).toBe("2026/07/01 16:00:00");
    adoptTimeZone("Asia/Tokyo");
    expect(getLocalHour(timestampMs)).toBe(5);
    expect(getDayIndex(timestampMs)).toBe(Math.floor((timestampMs + 9 * 3_600_000) / DAY_MS));
  });
});
