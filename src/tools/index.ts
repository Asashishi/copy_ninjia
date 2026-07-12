import { getCurrentTime } from "./time";
import { getTokyoWeather } from "./weather";

/**
 * 供 aiChat.ts 走 DeepSeek 的 function calling 接口调用的工具集合。
 * 每个工具都无入参、无副作用，出错时返回描述性的 JSON 字符串而不是
 * 抛错——模型收到工具结果后自己决定怎么向用户措辞。
 */

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

/** 工具名常量，供 aiChat.ts 强制指定 tool_choice 时引用，避免魔法字符串两处漂移。 */
export const GET_CURRENT_TIME_TOOL: string = "get_current_time";
export const GET_TOKYO_WEATHER_TOOL: string = "get_tokyo_weather";

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: GET_CURRENT_TIME_TOOL,
      description: "获取当前的日期和时间（东京时区，UTC+9）。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: GET_TOKYO_WEATHER_TOOL,
      description: "获取东京今天的实时天气状况与气温（摄氏度）。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

/** 按名字执行一个工具调用，返回喂回模型的字符串结果。 */
export async function callTool(name: string): Promise<string> {
  switch (name) {
    case GET_CURRENT_TIME_TOOL:
      return JSON.stringify(getCurrentTime());
    case GET_TOKYO_WEATHER_TOOL: {
      const result = await getTokyoWeather();
      return JSON.stringify(result ?? { error: "天气数据获取失败" });
    }
    default:
      return JSON.stringify({ error: `未知工具: ${name}` });
  }
}
