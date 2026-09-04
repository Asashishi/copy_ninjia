import { MAX_WEB_SEARCH_CALLS_PER_REPLY } from "../tools";

/**
 * 提示词里对服务端联网检索工具的统一称呼。
 *
 * Gemini 使用 `googleSearch`，OpenAI 使用 hosted `web_search`；模型提示只使用
 * 这份中立称呼，并按本轮实际挂载的工具执行。
 *
 * 所属模块：consts/aiChat/prompts/。
 */
export const WEB_SEARCH_TOOL_LABEL: string = "联网检索工具";

/**
 * 联网查证的固定决策规则。
 *
 * **整段逐字恒定**：只写每轮的次数上限这一个常量，不含当前余额和搜索进度，同一
 * 回复的每次模型往返复用相同的 system prompt。
 *
 * 次数是**软限制**：检索工具在一轮内恒挂，replyModel.ts 只记账并在跨过上限时点名，
 * 不再中途摘掉工具——它排在 tools 数组首位，摘一次就会让整段前缀缓存从第一个字节
 * 起落空。搜索结果随会话历史传入后续轮次。
 */
export const WEB_SEARCH_INSTRUCTION: string =
  `遇到会变化的现实信息或自己不能确认的可查事实，并且本轮提供${WEB_SEARCH_TOOL_LABEL}时，必须先搜索再做可见动作；` +
  "主观聊天、创作和转录中已经给出的事实不搜索。搜索结果优先于记忆；证据不足或没有检索工具时就明确不确定，不得补造。" +
  `同一轮回复最多检索 ${MAX_WEB_SEARCH_CALLS_PER_REPLY} 次，用满就凭手头材料作答，不要再检索。` +
  "搜索过程只供内部使用，不向群友解释。";
