import type { AtmosphereTexts } from "../../types/atmosphere";
/**
 * 群问答的文本解析与渲染：表单投递消息的字段解析，以及表单提示正文。
 *
 * `/qa query` 看板的分页渲染在同目录的 board.ts。
 */

import type { Message, MessageEntity } from "grammy/types";
import { captureFencedText } from "../../libs/codeFence";
import { QA_ANSWER_LABELS, QA_QUESTION_LABELS, QA_TRUNCATION_MARK } from "../../consts/qa";

import { TELEGRAM_MESSAGE_MAX_CHARS } from "../../consts/telegram";
import { truncateInline } from "../../libs/text";
import type { QaFieldInput } from "../../types/qa";

/** 一次行首标签命中：哪个字段、标签从哪开始、取值从哪开始。 */
interface QaLabelHit {
  readonly field: "q" | "a";
  readonly labelStart: number;
  readonly valueStart: number;
}

/**
 * 某个偏移是否落在代码块（`pre` 或 `code` 实体）内部；块内以标签开头的行不当作字段标签。
 */
function isInsideCodeEntity(
  entities: readonly MessageEntity[] | undefined,
  offset: number
): boolean {
  if (entities === undefined) return false;
  for (const entity of entities) {
    if (entity.type !== "pre" && entity.type !== "code") continue;
    if (offset >= entity.offset && offset < entity.offset + entity.length) return true;
  }
  return false;
}

/** 某个字段的标签是否正好起始于 lineStart；命中时返回取值起点。 */
function matchLabel(
  text: string,
  lineStart: number,
  labels: readonly string[]
): number | undefined {
  for (const label of labels) {
    if (text.startsWith(label, lineStart)) return lineStart + label.length;
  }
  return undefined;
}

/**
 * 逐行找出全部字段标签。
 *
 * 标签只在行首生效，且不在代码块内。
 */
function findQaLabels(
  text: string,
  entities: readonly MessageEntity[] | undefined
): readonly QaLabelHit[] {
  const hits: QaLabelHit[] = [];
  let lineStart: number = 0;
  while (lineStart <= text.length) {
    if (!isInsideCodeEntity(entities, lineStart)) {
      const question: number | undefined = matchLabel(text, lineStart, QA_QUESTION_LABELS);
      const answer: number | undefined = question === undefined
        ? matchLabel(text, lineStart, QA_ANSWER_LABELS)
        : undefined;
      if (question !== undefined) {
        hits.push({ field: "q", labelStart: lineStart, valueStart: question });
      } else if (answer !== undefined) {
        hits.push({ field: "a", labelStart: lineStart, valueStart: answer });
      }
    }
    const newlineIndex: number = text.indexOf("\n", lineStart);
    if (newlineIndex === -1) break;
    lineStart = newlineIndex + 1;
  }
  return hits;
}

/**
 * 从一条投递消息里解析出表单字段。
 *
 * 取值范围是「本标签之后到下一个标签之前」，两端 trim。回答里范围内的 `pre` 实体
 * 会被还原成字面 ``` 围栏，整块 ```json 原样存下；问题取原文切片，与问答直答
 * （auto/message/qaDirectAnswer.ts）比对的 `message.text`、`/qa remove`、
 * `/qa query <问题>` 读到的 `ctx.match` 同一口径。
 *
 * @returns 一个字段都解析不出（含取值为空）时为 undefined，调用方把消息放回消息流水线。
 */
export function parseQaFieldMessage(message: Message): QaFieldInput | undefined {
  const text: string | undefined = message.text;
  if (text === undefined) return undefined;
  const hits: readonly QaLabelHit[] = findQaLabels(text, message.entities);
  if (hits.length === 0) return undefined;
  let question: string | undefined;
  let answer: string | undefined;
  for (let index: number = 0; index < hits.length; index++) {
    const hit: QaLabelHit | undefined = hits[index];
    if (hit === undefined) continue;
    // 同一字段写了两次时以先出现的为准。
    if (hit.field === "q" ? question !== undefined : answer !== undefined) continue;
    const end: number = hits[index + 1]?.labelStart ?? text.length;
    const value: string = (hit.field === "q"
      ? text.slice(hit.valueStart, end)
      : captureFencedText({ text, entities: message.entities, start: hit.valueStart, end })).trim();
    if (value.length === 0) continue;
    if (hit.field === "q") question = value;
    else answer = value;
  }
  if (question === undefined && answer === undefined) return undefined;
  return { q: question, a: answer };
}

/**
 * 表单提示正文：把两项的当前状态摆出来。
 *
 * 开表单时两项皆空，此后每认领一项就由 `editQaForm` 用会话当前值重渲一次
 * （见 commands/qa.ts），两处共用本函数。
 *
 * 回答回显按剩余预算（TELEGRAM_MESSAGE_MAX_CHARS 减去前缀）截断，问题不截断；
 * 被截掉的只是回显，落库用的是会话里的完整值。
 *
 * @param q 必须已受 CHAT_QA_QUESTION_MAX_CHARS 约束：会话里这一项只由
 *   qa/ingress.ts 按该上限写入，剩余预算恒为正。
 */
export function renderQaFormPrompt(
  q: string | undefined,
  a: string | undefined,
  atmosphere: AtmosphereTexts
): string {
  const unset: string = atmosphere.QA_COMMAND_TEXTS.formUnset;
  const head: string = `${atmosphere.QA_COMMAND_TEXTS.formPrompt}\n` +
    `——\n已收到的问题：${q ?? unset}\n已收到的回答：`;
  const answer: string = a ?? unset;
  const budget: number = TELEGRAM_MESSAGE_MAX_CHARS - head.length;
  if (answer.length <= budget) return head + answer;
  return head +
    truncateInline(answer, budget - QA_TRUNCATION_MARK.length) +
    QA_TRUNCATION_MARK;
}
