/** 供 aiChatWorker.ts 走 DeepSeek 的 function calling 接口调用的工具定义结构。 */
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

export interface TokyoWeatherResult {
  currentTemperatureC: number;
  currentCondition: string;
  todayMaxC: number;
  todayMinC: number;
  todayCondition: string;
}

export interface CurrentTimeResult {
  iso: string;
  timezone: string;
  formatted: string;
}
