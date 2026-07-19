import { beforeEach, describe, expect, mock, test } from "bun:test";

const responses: unknown[] = [];
const fetchJsonWithTimeout = mock(async (..._args: unknown[]): Promise<unknown> => responses.shift() ?? null);
const loggerError = mock((..._args: unknown[]): void => {});

mock.module("../../src/libs/httpFetch", () => ({ fetchJsonWithTimeout }));
mock.module("../../src/infra/logger", () => ({
  logger: {
    log: mock((..._args: unknown[]): void => {}),
    info: mock((..._args: unknown[]): void => {}),
    warn: mock((..._args: unknown[]): void => {}),
    error: loggerError,
  },
}));

const { currentTokyoWeather, startWeatherRefreshLoop } = await import("../../src/ai/weather");
const { weatherCache } = await import("../../src/cache/weather");
const { WEATHER_API_URL, WEATHER_CODE_DESCRIPTIONS, WEATHER_REFRESH_INTERVAL_MS } = await import("../../src/consts/weather");

async function flushRefresh(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function validWeather(currentCode: number = 0, todayCode: number = 3): object {
  return {
    current: { temperature_2m: 31.5, weather_code: currentCode },
    daily: {
      temperature_2m_max: [35],
      temperature_2m_min: [26],
      weather_code: [todayCode],
    },
  };
}

beforeEach(() => {
  responses.length = 0;
  fetchJsonWithTimeout.mockClear();
  loggerError.mockClear();
  weatherCache.result = null;
  weatherCache.at = 0;
});

describe("Open-Meteo 适配层", () => {
  test("启动时立即刷新并注册唯一周期回调，合法响应写入共享缓存", async () => {
    responses.push(validWeather());
    const originalSetInterval: typeof setInterval = globalThis.setInterval;
    let intervalCallback: (() => void) | null = null;
    globalThis.setInterval = ((callback: (...args: unknown[]) => void, delay: number) => {
      expect(delay).toBe(WEATHER_REFRESH_INTERVAL_MS);
      intervalCallback = callback;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    try {
      startWeatherRefreshLoop();
      await flushRefresh();

      expect(intervalCallback).not.toBeNull();
      expect(currentTokyoWeather()).toEqual({
        currentTemperatureC: 31.5,
        currentCondition: WEATHER_CODE_DESCRIPTIONS[0]!,
        todayMaxC: 35,
        todayMinC: 26,
        todayCondition: WEATHER_CODE_DESCRIPTIONS[3]!,
      });
      const requestedUrl = fetchJsonWithTimeout.mock.calls[0]![0] as URL;
      expect(requestedUrl.origin + requestedUrl.pathname).toBe(WEATHER_API_URL);
      expect(requestedUrl.searchParams.get("timezone")).toBe("Asia/Tokyo");

      responses.push(validWeather(999, 998));
      intervalCallback!();
      await flushRefresh();
      expect(currentTokyoWeather()?.currentCondition).toContain("代码 999");
      expect(currentTokyoWeather()?.todayCondition).toContain("代码 998");
    } finally {
      globalThis.setInterval = originalSetInterval;
    }
  });

  test("网络失败或响应结构异常时保留上一份可用缓存", async () => {
    const previous = {
      currentTemperatureC: 20,
      currentCondition: "旧天气",
      todayMaxC: 22,
      todayMinC: 18,
      todayCondition: "旧预报",
    };
    weatherCache.result = previous;
    responses.push(null);
    const originalSetInterval: typeof setInterval = globalThis.setInterval;
    globalThis.setInterval = (() => 1 as unknown as ReturnType<typeof setInterval>) as typeof setInterval;
    try {
      startWeatherRefreshLoop();
      await flushRefresh();
      expect(currentTokyoWeather()).toBe(previous);
      expect(loggerError).not.toHaveBeenCalled();

      responses.push({ current: { temperature_2m: "hot" }, daily: {} });
      startWeatherRefreshLoop();
      await flushRefresh();
      expect(currentTokyoWeather()).toBe(previous);
      expect(loggerError).toHaveBeenCalledWith("Open-Meteo API returned unexpected shape:", expect.anything());
    } finally {
      globalThis.setInterval = originalSetInterval;
    }
  });
});
