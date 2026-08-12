import { expect, mock, test } from "bun:test";

const getCurrentTime = mock(() => ({
  iso: "2026-08-12T03:04:05.000Z",
  timezone: "Asia/Tokyo",
  formatted: "2026年8月12日星期三 12:04:05",
}));

mock.module("../../../packages/libs/time", () => ({ getCurrentTime }));

const { currentTimeSentence } = await import("../../../packages/workers/aiChat/timeSentence");

test("当前时间提示现取东京时间并保持两条 AI 路径共用的固定措辞", () => {
  expect(currentTimeSentence()).toBe(
    "当前实际时间：2026年8月12日星期三 12:04:05（东京时间 UTC+9）。"
  );
  expect(getCurrentTime).toHaveBeenCalledTimes(1);
});
