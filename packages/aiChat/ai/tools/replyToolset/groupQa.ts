/**
 * 群问答的两个查询工具：`group_qa_query` 与 `group_qa_answer`。
 *
 * 两个都是**纯查询**：不发消息、不改状态、不计入整轮可见动作预算。数据来自本轮
 * trigger 消息随附的那份问答表，因此执行期不跨线程、不读盘，就是一次 Map 查表。
 *
 * 分工要说清楚：**一字不差的提问根本到不了这里**——那种情况在主干上就被直答
 * 短路了（见 auto/message/qaDirectAnswer.ts），连 trigger 都不会发。能走到模型
 * 面前的只有「意思像但字面对不上」的问法，所以这两个工具存在的唯一理由就是让
 * 模型自己判断语义够不够近。
 */

import { GROUP_QA_ANSWER_TOOL, GROUP_QA_QUERY_TOOL } from "../../../../consts/tools";
import { toolError } from "../../utils/toolResult";
import type { AiToolDefinition } from "../../../../types/aiChat/provider";

/** 模型给 group_qa_answer 的入参形态。 */
interface GroupQaAnswerArguments {
  readonly question?: unknown;
}

/**
 * 本群没有问答时给空表，两个工具都不挂。
 *
 * 不挂比挂一个空工具好：模型看不到的工具不会被调用，也就不会为一个注定返回
 * 「本群没有问答」的东西白费一次工具往返。
 */
export function buildGroupQaToolDefinitions(
  entries: ReadonlyMap<string, string> | undefined
): readonly AiToolDefinition[] {
  if (entries === undefined || entries.size === 0) return [];
  return [
    {
      name: GROUP_QA_QUERY_TOOL,
      description:
        "列出本群已登记的问答问题清单。当前这句话像是在问其中某一条时，先用这个工具" +
        "看清单，再判断语义是否足够接近；接近才调 group_qa_answer 取答案。",
      parametersJsonSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: GROUP_QA_ANSWER_TOOL,
      description:
        "按问题原文取回本群登记的答案。question 必须是 group_qa_query 列出的原文之一，" +
        "不能改写。拿到答案后照着它的意思回答，不要编造清单之外的内容。",
      parametersJsonSchema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "group_qa_query 列出的问题原文，逐字照抄。",
          },
        },
        required: ["question"],
      },
    },
  ];
}

/** 列出问题清单；只给问题不给答案，逼模型先判断语义再取答案。 */
export function executeGroupQaQuery(
  entries: ReadonlyMap<string, string> | undefined
): string {
  if (entries === undefined || entries.size === 0) {
    return JSON.stringify({ questions: [] });
  }
  const questions: string[] = [];
  for (const question of entries.keys()) questions.push(question);
  return JSON.stringify({ questions });
}

/** 按原文取答案；对不上就如实说没有，绝不模糊匹配到别条上去。 */
export function executeGroupQaAnswer(
  entries: ReadonlyMap<string, string> | undefined,
  argumentsJson: string
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return toolError("group_qa_answer arguments must be valid JSON");
  }
  const question: unknown = (parsed as GroupQaAnswerArguments | null)?.question;
  if (typeof question !== "string" || question.length === 0) {
    return toolError("group_qa_answer requires a non-empty question string");
  }
  const answer: string | undefined = entries?.get(question);
  if (answer === undefined) {
    // 这里绝不做模糊匹配：模型拿着清单原文来调，对不上就是它改写了原文，
    // 此时替它猜一条最像的，等于把一条本群没登记过的答案说成登记过的。
    return JSON.stringify({ found: false, question });
  }
  return JSON.stringify({ found: true, question, answer });
}
