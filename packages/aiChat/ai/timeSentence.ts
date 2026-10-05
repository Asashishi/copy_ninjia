import { getCurrentTime } from "../../libs/time";
import type { CurrentTimeResult } from "../../types/time";

/**
 * 「<前缀>：<配置时区当前时间>（配置的 IANA 时区名）。」——运行时状态区块与压缩批末尾用
 * CURRENT_TIME_LABEL（consts/aiChat/prompts/memory.ts），联网检索查询与摘要组稿用
 * WEB_SEARCH_TIME_LABEL（consts/aiChat/prompts/researchTime.ts），每次调用现查时间，不缓存。
 *
 * 当前时间句都落在 user 内容里，且排在该请求每次都变的那一段之后：回复链路进运行时状态
 * 区块（转录之后），压缩链路拼在整批转录末尾，检索拼在查询末尾。新增调用点必须同样避开
 * systemInstruction/instructions 与各自请求的输入开头。提示词稳定前缀与动态内容的顺序
 * 约束见 docs/cn/04-invariants.md「AI 提示词与转录」。
 */
export function currentTimeSentence(label: string): string {
  const now: CurrentTimeResult = getCurrentTime();
  return `${label}：${now.formatted}（${now.timezone}）。`;
}
