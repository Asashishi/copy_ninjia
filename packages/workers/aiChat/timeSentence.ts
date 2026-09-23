import { getCurrentTime } from "../../libs/time";

/**
 * 「当前实际时间：...（东京时间 UTC+9）。」——runtimeState.ts 的
 * buildRuntimeStateBlock 与 compaction.ts 的 summarizeBatch 共用同一句措辞，
 * 由本函数统一生成；每次调用现查时间，不缓存。
 *
 * 两个调用点都落在 user 内容里，且都排在该请求每次都变的那一段之后：回复
 * 链路进运行时状态区块（转录之后），压缩链路拼在整批转录末尾。新增调用点必须
 * 同样避开 systemInstruction/instructions 与各自请求的输入开头。提示词稳定前缀
 * 与动态内容的顺序约束见 docs/cn/04-invariants.md「AI 提示词与转录」。
 */
export function currentTimeSentence(): string {
  return `当前实际时间：${getCurrentTime().formatted}（东京时间 UTC+9）。`;
}
