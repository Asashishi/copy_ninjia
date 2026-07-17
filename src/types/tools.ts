/** 供 workers/aiChatWorker.ts 走 Gemini generateContent 接口调用的自定义函数
 * 声明结构（tools 数组成员 functionDeclarations 里的一项），字段即
 * name/description/parameters（OpenAPI 子集 schema）。 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

/** Google 内置的服务端工具（联网搜索）：只声明存在，执行在 Google 服务器侧
 * 自动完成，不会像自定义函数那样把 functionCall 抛回来要结果。 */
export interface GoogleSearchToolDefinition {
  googleSearch: Record<string, never>;
}

/** 自定义函数声明在一次请求 tools 数组里的挂载形态：一组声明包在
 * functionDeclarations 字段下。 */
export interface FunctionDeclarationsTool {
  functionDeclarations: ToolDefinition[];
}

/** 一次 generateContent 请求的 tools 数组成员：自定义函数 + 内置服务端工具混用。 */
export type GeminiRequestTool = FunctionDeclarationsTool | GoogleSearchToolDefinition;

export interface TokyoWeatherResult {
  currentTemperatureC: number;
  currentCondition: string;
  todayMaxC: number;
  todayMinC: number;
  todayCondition: string;
}

/** 响应里一次待执行的自定义函数调用（内置服务端工具如 googleSearch
 *  不在此列，它们已在 Google 侧执行完）：parts 里的 functionCall 对象本身
 *  （id/name/args），见 ai/gemini.ts 的 extractFunctionCalls。 */
export interface ExtractedFunctionCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}
