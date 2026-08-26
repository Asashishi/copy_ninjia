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
 * 文案不包含当前余额和搜索进度，同一回复的每次模型往返复用相同的 system
 * prompt。replyModel.ts 核销真实额度并在耗尽后摘掉检索工具；搜索结果随会话
 * 历史传入后续轮次。
 */
export const WEB_SEARCH_INSTRUCTION: string =
  `遇到会变化的现实信息或自己不能确认的可查事实，并且本轮提供${WEB_SEARCH_TOOL_LABEL}时，必须先搜索再做可见动作；` +
  "主观聊天、创作和转录中已经给出的事实不搜索。搜索结果优先于记忆；证据不足或没有检索工具时就明确不确定，不得补造。" +
  "搜索过程只供内部使用，不向群友解释。";
