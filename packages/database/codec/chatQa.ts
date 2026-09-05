import { CHAT_QA_DATA_KEYS } from "../../consts/storageSchema";
import { CHAT_QA_ANSWER_MAX_CHARS, CHAT_QA_QUESTION_MAX_CHARS } from "../../consts/qa";
import { invalidInput, parseJsonInput } from "../../libs/inputValidation";
import { hasExactKeys, isPlainRecord } from "../../libs/record";
import type { ChatQaEntryData } from "../../types/qa";

/**
 * 校验问题文本可以作为主键落库。
 *
 * 两条都不是「顺手加的防御」：空串与带首尾空白的串会让直答路径的 Map 查表与
 * 用户看到的文本对不上（用户永远打不出一个前后带空格的问题），而超长键会把
 * 每条群消息都要付的哈希成本抬上去。写入侧先 trim 再进来，因此这里出现空白
 * 边界就说明调用方漏了那一步，属于编程错误而非用户输入问题。
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
 * 与解码共用同一组上限，所以「写得进去的一定读得回来」；调用方拿到的是可直接
 * 交给 Disk I/O Worker 的最终文本，Worker 不再重新组装结构。
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
