/** function calling 工具集合（packages/aiChat/ai/tools/index.ts）的调参常量。 */

/** get_tokyo_weather 工具名常量，避免魔法字符串两处漂移。 */
export const GET_TOKYO_WEATHER_TOOL: string = "get_tokyo_weather";

/** send_sticker 工具名常量（见 aiChat/ai/tools/stickers.ts）。这个工具不在静态清单
 *  里——它的可选贴纸清单随白名单目录变化，需要按次请求动态
 *  拼装，由 aiChat/ai/tools/replyToolset/ 按次回复组装进工具集。 */
export const SEND_STICKER_TOOL: string = "send_sticker";

/** view_sticker_pack 工具名常量（见 aiChat/ai/tools/stickers.ts）：两层贴纸选择的第一层，
 *  按整包简介挑包、查看包内贴纸清单，之后才能用 send_sticker 发送。 */
export const VIEW_STICKER_PACK_TOOL: string = "view_sticker_pack";

/** send_message 工具名常量（见 aiChat/ai/tools/replyToolset/sendMessage.ts）：模型往群里发一条文字
 *  消息的唯一途径——发言本身也是工具，模型自己决定发几条、什么顺序。 */
export const SEND_MESSAGE_TOOL: string = "send_message";

/** add_reaction 工具名常量（见 aiChat/ai/tools/replyToolset/reaction.ts）：给触发消息扣一个标准
 *  emoji 反应，同样由模型自主决定用不用。 */
export const ADD_REACTION_TOOL: string = "add_reaction";

/** generate_image 工具名：调用独立图片模型生成一张图片并发送到当前群。 */
export const GENERATE_IMAGE_TOOL: string = "generate_image";

/**
 * generate_song 工具名：调用独立生歌模型写一首歌并发送到当前群。
 *
 * 与上面几个的关键差别：这个工具**不是每轮都存在**。它只在当前闲聊供应商实现了
 * 生歌能力时才进本轮工具集（见 aiChat/ai/tools/replyToolset/orchestrator.ts 与
 * types/aiChat/provider.ts 的 AiChatProvider.generateSong）。名字仍要单点定义——
 * 它同时出现在工具声明、dispatch 分支和动作预算清单里。
 */
export const GENERATE_SONG_TOOL: string = "generate_song";

/**
 * group_qa_query 工具名：列出本群已登记的问答**问题清单**。
 *
 * 只在本群真的登记过问答时才进本轮工具集（见 replyToolset/groupQa.ts）。它是
 * 纯查询、不计入动作预算——模型先看清单，判断当前这句话是不是在问其中之一。
 * 一字不差的提问根本走不到模型：那种情况由主干直答短路（见
 * auto/message/qaDirectAnswer.ts）。到得了这里的都是「意思像但字面不同」。
 */
export const GROUP_QA_QUERY_TOOL: string = "group_qa_query";

/**
 * group_qa_answer 工具名：按问题原文取回登记的答案。
 *
 * 参数必须是 group_qa_query 列出的原文之一；模型自己判断语义是否够近，
 * 够近才调这个工具拿答案，再照着答案措辞。
 */
export const GROUP_QA_ANSWER_TOOL: string = "group_qa_answer";

/**
 * 会消耗整轮可见动作预算的工具名；查看贴纸包与查询类工具不计入。
 * 使用只读数组，调用方通过 includes 判断，避免共享 Set 被意外修改。
 *
 * generate_song 恒在清单里，即使本轮没挂那个工具：这份清单只回答「这个名字算不算
 * 可见动作」，不回答「本轮有没有这个工具」。后者由 toolset.has 判定。
 */
export const ACTION_TOOL_NAMES: readonly string[] = [
  SEND_MESSAGE_TOOL,
  ADD_REACTION_TOOL,
  SEND_STICKER_TOOL,
  GENERATE_IMAGE_TOOL,
  GENERATE_SONG_TOOL,
];

/**
 * 本轮回复已被 /ai_chat disable 作废时，所有动作工具统一返回的错误文案。
 * 每个执行器在自己的每个 await 边界前后都要检查一次代数，因此这条文案在
 * aiChat/ai/tools/ 下出现近十次；它是喂给模型的协议文本，必须逐字一致，只在这里定义。
 */
export const REPLY_INVALIDATED_TOOL_ERROR: string = "Reply invalidated because AI chat was disabled";

/**
 * 整轮自定义函数调用预算（MAX_CUSTOM_TOOL_CALLS_PER_REPLY）耗尽后，每一次多余调用
 * 统一拿到的工具结果，已序列化好。
 *
 * 预算耗尽**不摘工具声明**（一轮内 tools 必须逐字恒定，见 workers/aiChat/replyModel.ts
 * 的头注），因此模型仍看得见全部工具、还可能接着调；这段文案要把「别再调了，直接
 * 收尾」说清楚，否则它会一路撞到 MAX_TOOL_ROUNDS。
 */
export const TOOL_BUDGET_EXHAUSTED_RESULT: string = JSON.stringify({
  unavailable: "Tool budget exhausted for this reply; stop calling tools and finish now",
});

/** 模型调用了本轮工具集之外的名字时的统一错误文案（静态与按次组装的两个 dispatch 共用）。 */
export function unknownToolError(name: string): string {
  return `Unknown tool: ${name}`;
}
