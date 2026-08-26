/**
 * 群问答的文本解析与渲染：表单投递消息的字段解析，以及表单提示正文。
 *
 * `/query_qa` 看板的分页渲染在同目录的 board.ts；那边只负责把已登记的条目铺成
 * JSON 代码块，与这里的「把用户写的东西读出来」是相反的两个方向。
 */

import type { Message, MessageEntity } from "@grammyjs/types";
import { captureFencedText } from "../../libs/codeFence";
import {
  QA_ANSWER_LABELS,
  QA_COMMAND_TEXTS,
  QA_QUESTION_LABELS,
  QA_TRUNCATION_MARK,
} from "../../consts/qa";
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
 * 某个偏移是否落在代码块内部。
 *
 * 存在的理由是答案里那些整段 JSON：块内出现一行以「回答:」开头的文本时，
 * 若照样当成新字段的标签，答案会被从中间切断。`pre` 与 `code` 都算块内。
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
 * 标签只在**行首**生效：句子中间提到「回答:」的消息不该被当成表单投递，
 * 而用户按提示写的那两条永远是标签独占一行或紧跟取值。
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
 * 取值范围是「本标签之后到下一个标签之前」，两端 trim；范围内的 `pre` 实体会被
 * 还原成字面 ``` 围栏，因此用户直接粘一整块 ```json 也能原样存下来。
 *
 * @returns 一个字段都解析不出（含取值为空）时是 undefined——那条消息与本领域
 *   无关，调用方必须原样放回消息流水线，不能当成填错格式的表单吞掉。
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
    // 同一字段写了两次时以先出现的为准：后一段多半是用户重写时忘了删的草稿，
    // 静默用后者覆盖会让人看不出到底存了哪一段。
    if (hit.field === "q" ? question !== undefined : answer !== undefined) continue;
    const value: string = captureFencedText({
      text,
      entities: message.entities,
      start: hit.valueStart,
      end: hits[index + 1]?.labelStart ?? text.length,
    }).trim();
    if (value.length === 0) continue;
    if (hit.field === "q") question = value;
    else answer = value;
  }
  if (question === undefined && answer === undefined) return undefined;
  return { q: question, a: answer };
}

/**
 * 表单提示正文：把两项的当前状态摆出来，用户才知道还差哪个。
 *
 * 开表单时两项皆空，此后每认领一项就由 `editQaForm` 用会话当前值重渲一次
 * （见 commands/qa.ts）；两处必须共用这一份，表单正文才只有一种形态。
 *
 * **回答回显按剩余预算截断**。两项的上限（256 / 3840）各自独立，且分别来自
 * 不同的投递消息——单条入站消息的 4096 上限管不住它们的和，两项都填满时整段
 * 会达到 4216。表单是 `editMessageText` 单条直发、没有分页，超限只会换来
 * 400 与一张停在旧内容上的表单。问题**不截断**：它短、且是用户校对自己写了
 * 什么的依据；被截掉的只是回显，权威值仍在会话里，落库用的是那一份。
 *
 * @param q 必须已受 CHAT_QA_QUESTION_MAX_CHARS 约束——会话里这一项只由
 *   qa/ingress.ts 按该上限写入，剩余预算因此恒为正，不需要运行期兜底。
 */
export function renderQaFormPrompt(
  q: string | undefined,
  a: string | undefined
): string {
  const unset: string = QA_COMMAND_TEXTS.formUnset;
  const head: string = `${QA_COMMAND_TEXTS.formPrompt}\n` +
    `——\n已收到的问题：${q ?? unset}\n已收到的回答：`;
  const answer: string = a ?? unset;
  const budget: number = TELEGRAM_MESSAGE_MAX_CHARS - head.length;
  if (answer.length <= budget) return head + answer;
  return head +
    truncateInline(answer, budget - QA_TRUNCATION_MARK.length) +
    QA_TRUNCATION_MARK;
}
