/**
 * 群问答的两个查询工具：`group_qa_query` 与 `group_qa_answer`。
 *
 * 两个都是纯查询：不发消息、不改状态、不计入整轮可见动作预算。数据来自本轮
 * trigger 消息随附的那份问答表，执行期不跨线程、不读盘，只做 Map 查表。
 *
 * 一字不差的提问在主干上由 auto/message/qaDirectAnswer.ts 直答，不发 trigger；
 * 到模型面前的是字面对不上的问法，由模型用这两个工具判断语义是否足够近。
 */

import { GROUP_QA_ANSWER_TOOL, GROUP_QA_QUERY_TOOL } from "../../../../consts/tools";
import { TOOL_STATUS_POINTER } from "../../../../consts/aiChat/prompts/tools";
import { toolError } from "../../utils/toolResult";
import type { AiToolDefinition } from "../../../../types/aiChat/provider";

/** 模型给 group_qa_answer 的入参形态。 */
interface GroupQaAnswerArguments {
  readonly question?: unknown;
}

/**
 * 两个问答工具的声明，每轮恒挂、逐字恒定。
 *
 * 本群有没有登记问答只写进运行时状态区块的本轮工具状态（见 toolStatus.ts 的问答行），
 * 工具清单不随群变化；没登记的群调用时由执行器如实返回空清单或未找到。
 */
export function buildGroupQaToolDefinitions(): readonly AiToolDefinition[] {
  return [
    {
      name: GROUP_QA_QUERY_TOOL,
      description:
        "列出本群已登记的问答问题清单。当前这句话像是在问其中某一条时，先用这个工具" +
        "看清单，再判断语义是否足够接近；接近才调 group_qa_answer 取答案。" +
        `本群有没有登记问答，见 ${TOOL_STATUS_POINTER}；显示没有登记时不要调用。`,
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

/** 列出问题清单，只含问题不含答案。 */
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

/** 按原文取答案；对不上返回 found: false，不做模糊匹配。 */
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
    // 不做模糊匹配：原文对不上即返回未找到。
    return JSON.stringify({ found: false, question });
  }
  return JSON.stringify({ found: true, question, answer });
}
