import { currentTokyoWeather } from "../weather";
import { GET_TOKYO_WEATHER_TOOL, unknownToolError } from "../../consts/tools";
import { toolError } from "../utils/toolResult";
import type { ToolDefinition, TokyoWeatherResult } from "../../types/tools";

/**
 * AI 回复流水线的工具目录（packages/ai/tools/）。本文件是其中「静态查询工具」的
 * 清单与分发：每个工具都无入参、无副作用（纯查询），出错时返回描述性的
 * JSON 字符串而不是抛错——模型收到工具结果后自己决定怎么向用户措辞。
 * （查时间不是工具：当前时间默认拼进每次请求的系统提示词，转录行也自带
 * 每条消息的发送时间，见 libs/time.ts 的 getCurrentTime、
 * workers/aiChat/geminiReply.ts 与 ai/utils/chatTranscript.ts。）
 * 有副作用的行动工具（发言/反应/两层贴纸/生图）不在这份静态清单里——它们需要
 * chatId 与每轮限额状态，且贴纸清单随目录内容变化、要按次回复现组装，见
 * 同目录的 replyToolset/ / stickers.ts。
 */

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: GET_TOKYO_WEATHER_TOOL,
    description: "获取东京今天的实时天气状况与气温（摄氏度）。",
    parameters: { type: "object", properties: {}, required: [] },
  },
];

/** 按名字执行一个工具调用，返回喂回模型的字符串结果。 */
export function callTool(name: string): string {
  switch (name) {
    case GET_TOKYO_WEATHER_TOOL: {
      // 只读现有缓存，不在这里发请求——真正的刷新由 ai/weather.ts 的后台
      // 定时循环负责，见该文件模块头注。
      const result: TokyoWeatherResult | null = currentTokyoWeather();
      return JSON.stringify(result ?? { error: "Weather data not available yet" });
    }
    default:
      return toolError(unknownToolError(name));
  }
}
