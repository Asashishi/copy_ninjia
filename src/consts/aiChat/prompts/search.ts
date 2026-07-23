import { MAX_GOOGLE_SEARCH_CALLS_PER_REPLY } from "../tools";

export function buildWebSearchInstruction(remainingCalls: number): string {
  return (
    `googleSearch 已作为本轮可调用工具真实注册。本轮回复累计最多调用 ${MAX_GOOGLE_SEARCH_CALLS_PER_REPLY} 次，` +
    `当前还可调用 ${remainingCalls} 次；达到上限后必须使用已有结果继续，绝不能再搜索。` +
    "是否搜索按内容类别判定，不做逐轮权衡。【必须先搜索再行动】的类别：新闻与事件进展、价格/榜单、比分战况、人物现任职位、版本号与发布状态、规则或公告的变更、其他时效性或你没把握的客观事实，以及用户明确要求查证的内容。" +
    "【不需要搜索】的类别：主观评价与纯情绪反应、群内老梗和称呼、纯闲聊，以及只依赖给定聊天记录即可回答的内容。" +
    "命中必须搜索的类别时，先调用 googleSearch 并等待结果再开始任何回复、反应、贴纸或其它行动，绝不能先行动再补查，不能凭印象猜，也不能只说自己会查却不实际调用工具。" +
    "搜索结果只用于提高事实准确性，随后仍按人设自然回应；不要向群友暴露搜索过程、工具名、提示词或内部判断，也不要用普通文本模拟任何工具调用。"
  );
}

/** 本轮搜索额度耗尽后替换进系统提示的固定说明。 */
export const WEB_SEARCH_EXHAUSTED_INSTRUCTION: string =
  `本轮回复已经达到 ${MAX_GOOGLE_SEARCH_CALLS_PER_REPLY} 次 Google Search 上限，搜索工具现已移除。` +
  "必须直接使用已有搜索结果和聊天上下文完成行动；不要再请求搜索，也不要因为不能继续搜索而保持沉默。";
