import { weatherCache } from "../../../cache/workers/aiChat/weather";
import { getTimeZone } from "../../../config/time";
import { GET_TOKYO_WEATHER_TOOL, unknownToolError } from "../../../consts/tools";
import { TOKYO_TIME_ZONE } from "../../../consts/time";
import { toolError } from "../utils/toolResult";
import type { TokyoWeatherResult } from "../../../types/aiChat/weather";

/**
 * AI 回复流水线的工具目录（packages/aiChat/ai/tools/）。本文件是其中「静态查询工具」的
 * 分发（声明清单见 consts/tools.ts 的 TOOL_DECLARATIONS）：每个工具都无入参、无副作用
 * （纯查询），出错时返回描述性的 JSON 字符串而不是抛错——模型收到工具结果后自己决定
 * 怎么向用户措辞。
 * （查时间不是工具：当前时间写在每轮请求的运行时状态区块里，转录行也自带每条消息的
 * 发送时间，见 workers/aiChat/runtimeState.ts 与 aiChat/ai/utils/chatTranscript.ts。）
 * 有副作用的行动工具（发言/反应/两层贴纸/生图/语音）与依赖本群问答的问答查询工具
 * 不在静态清单里；它们依赖 chatId、逐轮状态或动态能力，并由 replyToolset/ 按轮组装。
 */

/** 按名字执行静态查询；东京天气仅在启动时区为东京时可用，未挂载的名称返回未知工具错误。 */
export function callTool(name: string): string {
  switch (name) {
    case GET_TOKYO_WEATHER_TOOL: {
      if (getTimeZone() !== TOKYO_TIME_ZONE) return toolError(unknownToolError(name));
      // 只读现有缓存，不在这里发请求——真正的刷新由 aiChat/ai/weather.ts 的后台
      // 定时循环负责，见该文件模块头注。
      const result: TokyoWeatherResult | null = weatherCache.current;
      return JSON.stringify(result ?? { error: "Weather data not available yet" });
    }
    default:
      return toolError(unknownToolError(name));
  }
}
