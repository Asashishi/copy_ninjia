/** function calling 工具集合（src/ai/tools/index.ts）的调参常量。 */

/** get_tokyo_weather 工具名常量，避免魔法字符串两处漂移。 */
export const GET_TOKYO_WEATHER_TOOL: string = "get_tokyo_weather";

/** send_sticker 工具名常量（见 ai/tools/stickers.ts）。这个工具不在静态清单
 *  里——它的可选贴纸清单随白名单目录变化，需要按次请求动态
 *  拼装，由 ai/tools/replyToolset.ts 按次回复组装进工具集。 */
export const SEND_STICKER_TOOL: string = "send_sticker";

/** view_sticker_pack 工具名常量（见 ai/tools/stickers.ts）：两层贴纸选择的第一层，
 *  按整包简介挑包、查看包内贴纸清单，之后才能用 send_sticker 发送。 */
export const VIEW_STICKER_PACK_TOOL: string = "view_sticker_pack";

/** send_message 工具名常量（见 ai/tools/replyToolset.ts）：模型往群里发一条文字
 *  消息的唯一途径——发言本身也是工具，模型自己决定发几条、什么顺序。 */
export const SEND_MESSAGE_TOOL: string = "send_message";

/** add_reaction 工具名常量（见 ai/tools/replyToolset.ts）：给触发消息扣一个标准
 *  emoji 反应，同样由模型自主决定用不用。 */
export const ADD_REACTION_TOOL: string = "add_reaction";

/** generate_image 工具名：调用独立图片模型生成一张图片并发送到当前群。 */
export const GENERATE_IMAGE_TOOL: string = "generate_image";
