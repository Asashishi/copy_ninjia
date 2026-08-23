/** 群问答的文本渲染：inline 结果、`/query_qa` 的 JSON 代码块与表单提示。 */

import type { MessageEntity } from "@grammyjs/types";
import type { QaEntry } from "../../types/qa";
import {
  QA_INLINE_ANSWER_LABEL,
  QA_INLINE_QUESTION_LABEL,
  QA_COMMAND_TEXTS,
} from "../../consts/qa";

/** 一条带 `pre` 代码块实体的消息；offset/length 按 UTF-16 code unit 计。 */
export interface QaJsonMessage {
  readonly text: string;
  readonly entities: readonly MessageEntity[];
}

/**
 * 把问答渲染成可复制的 JSON 代码块。
 *
 * 与 `/permission query` 同一套渲染口径：前缀 + `pre` 代码块，实体偏移按
 * **UTF-16 code unit** 计算——写死成别的长度不会报错，只会让 Telegram 把
 * 代码块画歪或整段吞掉。
 */
export function formatQaJsonMessage(
  entries: readonly QaEntry[]
): QaJsonMessage {
  const prefix: string = QA_COMMAND_TEXTS.queryPrefix;
  // 单条与多条用同一套渲染：单条时直接给对象，正好是规格里写的那个形状。
  const payload: unknown = entries.length === 1 ? entries[0] : entries;
  const json: string = JSON.stringify(payload, null, 2);
  return {
    text: `${prefix}${json}`,
    entities: [{
      type: "pre",
      offset: prefix.length,
      length: json.length,
      language: "json",
    }],
  };
}

/** inline 结果落群时的正文；标签同时是 ingress 的认领判据之一。 */
export function renderQaInlineResult(field: "q" | "a", text: string): string {
  const label: string = field === "q" ? QA_INLINE_QUESTION_LABEL : QA_INLINE_ANSWER_LABEL;
  return `${label}${text}`;
}

/**
 * 从落群正文里取回原始文本。
 *
 * @returns 前缀对不上时返回 undefined——那说明这条消息不是本领域签发的结果。
 */
export function parseQaInlineResult(
  text: string
): Readonly<{ field: "q" | "a"; value: string }> | undefined {
  if (text.startsWith(QA_INLINE_QUESTION_LABEL)) {
    return { field: "q", value: text.slice(QA_INLINE_QUESTION_LABEL.length) };
  }
  if (text.startsWith(QA_INLINE_ANSWER_LABEL)) {
    return { field: "a", value: text.slice(QA_INLINE_ANSWER_LABEL.length) };
  }
  return undefined;
}

/** 表单提示正文：把两项的当前状态摆出来，用户才知道还差哪个。 */
export function renderQaFormPrompt(
  q: string | undefined,
  a: string | undefined
): string {
  const unset: string = QA_COMMAND_TEXTS.formUnset;
  return `${QA_COMMAND_TEXTS.formPrompt}\n` +
    `问题：${q ?? unset}\n` +
    `答案：${a ?? unset}`;
}
