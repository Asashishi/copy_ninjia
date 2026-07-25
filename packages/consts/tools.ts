/** function calling 工具集合（packages/ai/tools/index.ts）的调参常量。 */

/** get_tokyo_weather 工具名常量，避免魔法字符串两处漂移。 */
export const GET_TOKYO_WEATHER_TOOL: string = "get_tokyo_weather";

/** send_sticker 工具名常量（见 ai/tools/stickers.ts）。这个工具不在静态清单
 *  里——它的可选贴纸清单随白名单目录变化，需要按次请求动态
 *  拼装，由 ai/tools/replyToolset/ 按次回复组装进工具集。 */
export const SEND_STICKER_TOOL: string = "send_sticker";

/** view_sticker_pack 工具名常量（见 ai/tools/stickers.ts）：两层贴纸选择的第一层，
 *  按整包简介挑包、查看包内贴纸清单，之后才能用 send_sticker 发送。 */
export const VIEW_STICKER_PACK_TOOL: string = "view_sticker_pack";

/** send_message 工具名常量（见 ai/tools/replyToolset/sendMessage.ts）：模型往群里发一条文字
 *  消息的唯一途径——发言本身也是工具，模型自己决定发几条、什么顺序。 */
export const SEND_MESSAGE_TOOL: string = "send_message";

/** add_reaction 工具名常量（见 ai/tools/replyToolset/reaction.ts）：给触发消息扣一个标准
 *  emoji 反应，同样由模型自主决定用不用。 */
export const ADD_REACTION_TOOL: string = "add_reaction";

/** generate_image 工具名：调用独立图片模型生成一张图片并发送到当前群。 */
export const GENERATE_IMAGE_TOOL: string = "generate_image";

/**
 * 会消耗整轮可见动作预算的工具名；查看贴纸包与查询类工具不计入。
 * 使用只读数组，调用方通过 includes 判断，避免共享 Set 被意外修改。
 */
export const ACTION_TOOL_NAMES: readonly string[] = Object.freeze([
  SEND_MESSAGE_TOOL,
  ADD_REACTION_TOOL,
  SEND_STICKER_TOOL,
  GENERATE_IMAGE_TOOL,
]);

/**
 * 本轮回复已被 /ai_chat disable 作废时，所有动作工具统一返回的错误文案。
 * 每个执行器在自己的每个 await 边界前后都要检查一次代数，因此这条文案在
 * ai/tools/ 下出现近十次；它是喂给模型的协议文本，必须逐字一致，只在这里定义。
 */
export const REPLY_INVALIDATED_TOOL_ERROR: string = "Reply invalidated because AI chat was disabled";

/** 模型调用了本轮工具集之外的名字时的统一错误文案（静态与按次组装的两个 dispatch 共用）。 */
export function unknownToolError(name: string): string {
  return `Unknown tool: ${name}`;
}
