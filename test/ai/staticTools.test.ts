import { afterEach, describe, expect, test } from "bun:test";
import { weatherCache } from "../../packages/cache/weather";
import { GET_TOKYO_WEATHER_TOOL } from "../../packages/consts/tools";
import { callTool, TOOL_DEFINITIONS } from "../../packages/ai/tools";

afterEach(() => {
  weatherCache.result = null;
  weatherCache.at = 0;
});

describe("AI 静态查询工具", () => {
  test("天气缓存未就绪时返回可诊断错误", () => {
    expect(TOOL_DEFINITIONS.map((definition) => definition.name)).toContain(GET_TOKYO_WEATHER_TOOL);
    expect(JSON.parse(callTool(GET_TOKYO_WEATHER_TOOL))).toEqual({ error: "Weather data not available yet" });
  });

  test("返回已有天气快照，并拒绝未知工具名", () => {
    weatherCache.result = {
      currentTemperatureC: 31,
      currentCondition: "晴",
      todayMaxC: 34,
      todayMinC: 25,
      todayCondition: "晴间多云",
    };
    expect(JSON.parse(callTool(GET_TOKYO_WEATHER_TOOL))).toEqual(weatherCache.result);
    expect(JSON.parse(callTool("missing_tool"))).toEqual({ error: "Unknown tool: missing_tool" });
  });
});
