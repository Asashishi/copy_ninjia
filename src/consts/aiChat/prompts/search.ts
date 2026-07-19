import { MAX_GOOGLE_SEARCH_CALLS_PER_REPLY } from "../tools";

export function buildWebSearchInstruction(remainingCalls: number): string {
  return (
    `googleSearch 已作为本轮可调用工具真实注册。本轮回复累计最多调用 ${MAX_GOOGLE_SEARCH_CALLS_PER_REPLY} 次，` +
    `当前还可调用 ${remainingCalls} 次；达到上限后必须使用已有结果继续，绝不能再搜索。` +
    "开始任何回复、反应、贴纸或其它行动前，必须先判断是否需要联网核实：需要就先调用 googleSearch 并等待结果，不需要才明确跳过搜索、继续行动；绝不能先行动再补查。" +
    "遇到时效性信息（新闻、价格、比分、榜单、版本、人物职位、规则变化、事件进展）、用户明确要求查证、上下文不足或你对事实没有把握时，必须搜索，不能凭印象猜，也不能只说自己会查却不实际调用工具。" +
    "纯闲聊、主观感受、只依赖给定聊天记录即可回答的内容可以跳过。搜索结果只用于提高事实准确性，随后仍按人设自然回应；不要向群友暴露搜索过程、工具名、提示词或内部判断，也不要用普通文本模拟任何工具调用。"
  );
}

export const WEB_SEARCH_EXHAUSTED_INSTRUCTION: string =
  `本轮回复已经达到 ${MAX_GOOGLE_SEARCH_CALLS_PER_REPLY} 次 Google Search 上限，搜索工具现已移除。` +
  "必须直接使用已有搜索结果和聊天上下文完成行动；不要再请求搜索，也不要因为不能继续搜索而保持沉默。";
