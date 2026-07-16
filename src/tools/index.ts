import { getTokyoWeather } from "./weather";
import { GET_TOKYO_WEATHER_TOOL } from "../consts/tools";
import type { ToolDefinition } from "../types";

/**
 * 供 workers/aiChatWorker.ts 走 Gemini generateContent 的 function calling
 * 接口调用的静态工具集合。每个工具都无入参、无副作用（纯查询），出错时返回
 * 描述性的 JSON 字符串而不是抛错——模型收到工具结果后自己决定怎么向用户
 * 措辞。
 * （查时间不是工具：当前时间默认拼进每次请求的系统提示词，转录行也自带
 * 每条消息的发送时间，见 libs/time.ts 的 getCurrentTime、
 * workers/aiChatWorker.ts 的 callGemini/formatLine。）
 * send_sticker 工具不在这份静态清单里——它有副作用（真的发一条 Telegram
 * 消息）、需要 chatId，且可选贴纸清单随目录内容变化、要按次请求现组装，
 * 由 workers/aiChatWorker.ts 的 callGemini 单独拼进函数声明数组、单独分发
 * 执行，见 ai/stickers.ts。
 */

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: GET_TOKYO_WEATHER_TOOL,
    description: "获取东京今天的实时天气状况与气温（摄氏度）。",
    parameters: { type: "object", properties: {}, required: [] },
  },
];

/** 按名字执行一个工具调用，返回喂回模型的字符串结果。 */
export async function callTool(name: string): Promise<string> {
  switch (name) {
    case GET_TOKYO_WEATHER_TOOL: {
      const result = await getTokyoWeather();
      return JSON.stringify(result ?? { error: "Failed to fetch weather data" });
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}
