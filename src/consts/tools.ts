/** function calling 工具集合（src/tools/index.ts）的调参常量。 */

/** get_tokyo_weather 工具名常量，避免魔法字符串两处漂移。 */
export const GET_TOKYO_WEATHER_TOOL: string = "get_tokyo_weather";

/** send_sticker 工具名常量（见 ai/stickers.ts）。这个工具不在 src/tools/
 *  的静态清单里——它的可选贴纸清单随白名单目录变化，需要按次请求动态
 *  拼装，由 workers/aiChatWorker.ts 的 callGemini 直接组装进函数声明数组。 */
export const SEND_STICKER_TOOL: string = "send_sticker";
