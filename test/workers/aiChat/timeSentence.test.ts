import { beforeEach, expect, mock, test } from "bun:test";

const getCurrentTime = mock(() => ({
  iso: "2026-08-12T03:04:05.000Z",
  timezone: "Asia/Tokyo",
  formatted: "2026年8月12日星期三 12:04:05",
}));

mock.module("../../../packages/libs/time", () => ({ getCurrentTime }));

const { currentTimeSentence } = await import("../../../packages/workers/aiChat/timeSentence");
beforeEach((): void => { getCurrentTime.mockClear(); });

test("当前时间提示现取配置时区并保持两条 AI 路径共用的固定措辞", () => {
  expect(currentTimeSentence()).toBe(
    "当前实际时间：2026年8月12日星期三 12:04:05（Asia/Tokyo）。"
  );
  expect(getCurrentTime).toHaveBeenCalledTimes(1);
});

test("当前时间提示展示实际时区，不附加固定 UTC 偏移", () => {
  getCurrentTime.mockReturnValueOnce({
    iso: "2026-08-12T03:04:05.000Z",
    timezone: "America/New_York",
    formatted: "2026年8月11日星期二 23:04:05",
  });
  expect(currentTimeSentence()).toBe(
    "当前实际时间：2026年8月11日星期二 23:04:05（America/New_York）。"
  );
});
