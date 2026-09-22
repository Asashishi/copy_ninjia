import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";

const responses: unknown[] = [];
const fetchJsonWithTimeout = mock(async (..._args: unknown[]): Promise<unknown> => responses.shift() ?? null);
const loggerError = mock((..._args: unknown[]): void => {});

mock.module("../../../packages/infra/httpFetch", () => ({ fetchJsonWithTimeout }));
mock.module("../../../packages/infra/logger", () => ({
  logger: loggerStub({ error: loggerError }),
}));

const {
  currentTokyoWeather,
  startWeatherRefreshLoop,
  stopWeatherRefreshLoop,
} = await import("../../../packages/aiChat/ai/weather");
const { weatherCache } = await import("../../../packages/cache/workers/aiChat/weather");
const { WEATHER_API_URL, WEATHER_CODE_DESCRIPTIONS, WEATHER_REFRESH_INTERVAL_MS } = await import("../../../packages/consts/weather");

async function flushRefresh(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function validWeather(currentCode: number = 0, todayCode: number = 3, temperature: number = 31.5): object {
  return {
    current: { temperature_2m: temperature, weather_code: currentCode },
    daily: {
      temperature_2m_max: [35],
      temperature_2m_min: [26],
      weather_code: [todayCode],
    },
  };
}

beforeEach(() => {
  stopWeatherRefreshLoop();
  responses.length = 0;
  fetchJsonWithTimeout.mockClear();
  loggerError.mockClear();
  weatherCache.current = null;
});

afterEach((): void => stopWeatherRefreshLoop());

describe("Open-Meteo 适配层", () => {
  test("启动时立即刷新并注册唯一周期回调，合法响应写入共享缓存", async () => {
    responses.push(validWeather());
    const originalSetInterval: typeof setInterval = globalThis.setInterval;
    let intervalCallback: (() => void) | null = null;
    globalThis.setInterval = ((callback: (...args: unknown[]) => void, delay: number) => {
      expect(delay).toBe(WEATHER_REFRESH_INTERVAL_MS);
      intervalCallback = callback;
      return { unref(): void {} } as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    try {
      startWeatherRefreshLoop();
      startWeatherRefreshLoop();
      await flushRefresh();
      expect(fetchJsonWithTimeout).toHaveBeenCalledTimes(1);

      expect(intervalCallback).not.toBeNull();
      expect(currentTokyoWeather()).toEqual({
        currentTemperatureC: 31.5,
        currentCondition: WEATHER_CODE_DESCRIPTIONS[0]!,
        todayMaxC: 35,
        todayMinC: 26,
        todayCondition: WEATHER_CODE_DESCRIPTIONS[3]!,
      });
      const requestedUrl = (fetchJsonWithTimeout.mock.calls[0]![0] as { input: URL }).input;
      expect(requestedUrl.origin + requestedUrl.pathname).toBe(WEATHER_API_URL);
      expect(requestedUrl.searchParams.get("timezone")).toBe("Asia/Tokyo");

      responses.push(validWeather(999, 998));
      intervalCallback!();
      await flushRefresh();
      expect(currentTokyoWeather()?.currentCondition).toContain("代码 999");
      expect(currentTokyoWeather()?.todayCondition).toContain("代码 998");
      stopWeatherRefreshLoop();
      intervalCallback!();
      expect(fetchJsonWithTimeout).toHaveBeenCalledTimes(2);
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
    weatherCache.current = previous;
    responses.push(null);
    const originalSetInterval: typeof setInterval = globalThis.setInterval;
    globalThis.setInterval = (() => ({ unref(): void {} }) as unknown as ReturnType<typeof setInterval>) as typeof setInterval;
    try {
      startWeatherRefreshLoop();
      await flushRefresh();
      expect(currentTokyoWeather()).toBe(previous);
      expect(loggerError).not.toHaveBeenCalled();

      responses.push({ current: { temperature_2m: "hot" }, daily: {} });
      stopWeatherRefreshLoop();
      startWeatherRefreshLoop();
      await flushRefresh();
      expect(currentTokyoWeather()).toBe(previous);
      expect(loggerError).toHaveBeenCalledWith("Open-Meteo API returned unexpected shape:", expect.anything());
    } finally {
      globalThis.setInterval = originalSetInterval;
    }
  });

  test("停止取消请求，迟到成功不得填充缓存", async (): Promise<void> => {
    const pending: PromiseWithResolvers<unknown> = Promise.withResolvers<unknown>();
    responses.push(pending.promise);
    startWeatherRefreshLoop();
    const signal: AbortSignal = (fetchJsonWithTimeout.mock.calls[0]![0] as { init: { signal: AbortSignal } }).init.signal;
    expect(signal.aborted).toBe(false);
    stopWeatherRefreshLoop();
    expect(signal.aborted).toBe(true);
    pending.resolve(validWeather());
    await flushRefresh();
    expect(currentTokyoWeather()).toBeNull();
  });

  test.each([validWeather(0, 3, 10), null, { current: "invalid" }])(
    "重开后旧循环的迟到结果不影响新缓存：%j",
    async (late: unknown): Promise<void> => {
      const old: PromiseWithResolvers<unknown> = Promise.withResolvers<unknown>();
      const current: PromiseWithResolvers<unknown> = Promise.withResolvers<unknown>();
      responses.push(old.promise, current.promise);
      startWeatherRefreshLoop();
      stopWeatherRefreshLoop();
      startWeatherRefreshLoop();
      current.resolve(validWeather(0, 3, 20));
      await flushRefresh();
      expect(currentTokyoWeather()?.currentTemperatureC).toBe(20);
      old.resolve(late);
      await flushRefresh();
      expect(currentTokyoWeather()?.currentTemperatureC).toBe(20);
      expect(loggerError).not.toHaveBeenCalled();
    }
  );
});
