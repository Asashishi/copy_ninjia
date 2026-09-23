import { CHAT_QA_DATA_KEYS } from "../../consts/storageSchema";
import { CHAT_QA_ANSWER_MAX_CHARS, CHAT_QA_QUESTION_MAX_CHARS } from "../../consts/qa";
import { invalidInput, parseJsonInput } from "../../libs/inputValidation";
import { hasExactKeys, isPlainRecord } from "../../libs/record";
import type { ChatQaEntryData } from "../../types/qa";

/**
 * 校验问题文本可以作为主键落库。
 *
 * 调用方须在调用前完成 trim；本函数拒绝空串、首尾带空白或超过上限长度的问题文本。
 */
export function assertChatQaQuestion(q: string, source: string): void {
  if (q.length === 0 || q.trim().length !== q.length) {
    invalidInput(source, "$.q", "a non-empty question without leading or trailing whitespace");
  }
  if (q.length > CHAT_QA_QUESTION_MAX_CHARS) {
    invalidInput(source, "$.q", `a question of at most ${CHAT_QA_QUESTION_MAX_CHARS} characters`);
  }
}

/** 严格解码 `chat_qa.data`；存在但非法的字段不会被默认值掩盖。 */
export function decodeChatQaData(text: string, source: string): ChatQaEntryData {
  const value: unknown = parseJsonInput(text, source);
  if (!isPlainRecord(value) || !hasExactKeys(value, CHAT_QA_DATA_KEYS)) {
    return invalidInput(source, "$", "an object with exactly the answer field");
  }
  const answer: unknown = value.a;
  if (typeof answer !== "string" || answer.length === 0) {
    return invalidInput(source, "$.a", "a non-empty string");
  }
  if (answer.length > CHAT_QA_ANSWER_MAX_CHARS) {
    return invalidInput(source, "$.a", `an answer of at most ${CHAT_QA_ANSWER_MAX_CHARS} characters`);
  }
  return { a: answer };
}

/**
 * 把一条答案编码为落库 JSON 文本。
 *
 * 与 decodeChatQaData 共用同一组长度上限，编码结果可被同一解码器还原。
 * 返回值可直接交给 Disk I/O Worker 写入，Worker 不再重新组装结构。
 */
export function encodeChatQaData(answer: string, source: string): string {
  if (answer.length === 0) {
    return invalidInput(source, "$.a", "a non-empty string");
  }
  if (answer.length > CHAT_QA_ANSWER_MAX_CHARS) {
    return invalidInput(source, "$.a", `an answer of at most ${CHAT_QA_ANSWER_MAX_CHARS} characters`);
  }
  return JSON.stringify({ a: answer });
}
