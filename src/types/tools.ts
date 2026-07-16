/** 供 workers/aiChatWorker.ts 走 xAI /v1/responses 接口调用的自定义函数工具
 * 定义结构。responses API 用的是扁平形态（name/description/parameters 直接
 * 挂在顶层），不是 chat completions 时代嵌在 function 字段里的旧形态。 */
export interface ToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

/** xAI 内置的服务端工具（联网搜索）：只声明类型，执行在 xAI 服务器侧自动
 * 完成，不会像自定义函数那样把 function_call 抛回来要结果。 */
export interface WebSearchToolDefinition {
  type: "web_search";
}

/** 一次 /v1/responses 请求的 tools 数组成员：自定义函数 + 内置服务端工具混用。 */
export type XaiRequestTool = ToolDefinition | WebSearchToolDefinition;

export interface TokyoWeatherResult {
  currentTemperatureC: number;
  currentCondition: string;
  todayMaxC: number;
  todayMinC: number;
  todayCondition: string;
}
