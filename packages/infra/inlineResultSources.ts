import type {
  InlineQueryResult,
  InputMessageContent,
} from "grammy/types";
import { inlineResultSources } from "../cache/main/inlineResultSources";
import { INLINE_RESULT_SOURCE_MAX_AUTHORS } from "../consts/telegram";
import type { InlineResultSource } from "../types/telegram";

/**
 * 「本 bot 的 inline 结果 → 用户打进查询的源文本」登记表。
 *
 * **所有 inline 功能共用这一条通道**：结果正文由本 bot 渲染，用户真正写的字只
 * 存在于 inline 查询里，而 Telegram 不会把查询原文放进落群消息，也没有把消息与
 * 查询关联起来的字段。因此对应关系只能在应答那一刻按发言身份登记，落群后按
 * 发送者 id 与结果正文取回。
 *
 * 当前的读取方只有广告检测（见 antiRaid/adCandidate.ts）：它据此判用户自己写的
 * 那句话，而不是本 bot 的渲染结果。新增 inline 功能必须在应答之后调用
 * recordInlineResultSources；不登记不会出错，但它的结果一律拿不到源文本，也就
 * 一律不进广告判定。
 *
 * 这里登记的内容**只是送检文本来源**，不是身份、群绑定或有效期的凭据：任何
 * 路径都不得据此放行或拒绝一条发言。
 */

/**
 * 取出一条结果自带的消息正文。游戏结果整个类型都没有 input_message_content，
 * 而媒体、位置等内容类型有该字段却不带文本；两种都没有可登记的正文。
 */
function inlineResultText(result: InlineQueryResult): string | undefined {
  if (!("input_message_content" in result)) return undefined;
  const content: InputMessageContent | undefined = result.input_message_content;
  if (content === undefined || !("message_text" in content)) return undefined;
  return content.message_text;
}

/**
 * 登记一次 inline 应答：整体覆盖该发言身份上一次的登记。
 *
 * speakerId 是这批结果落群后的发送者 id，与 antiRaid/adCandidate.ts 取的
 * `sender_chat?.id ?? from.id` 同一口径：gag 为会话目标（用户本人或频道），
 * 运势为查询者本人。
 *
 * 传的就是交给 answerInlineQuery 的那份结果数组，正文由本函数取，调用方
 * 不必自己拼——渲染与登记之间不再有第二处需要保持一致的文本。
 *
 * 调用方在 answerInlineQuery 结算之后登记；Bot API 明确拒收
 * （infra/telegram/errors.ts 的 isTelegramRequestRejected）时不登记，保留上一次
 * 送达的那份。update 串行处理，落群消息不会先于这次登记被处理。
 *
 * inline 查询每敲一个键就来一次，只有最后一次送达的应答里的结果才可能被发出去，
 * 因此不保留历史；同一次应答的多条结果（如同一个人在多个群同时被 gag）共享同一段
 * 源文本，必须一起登记，否则选中其中任意一条都会取不回源文本。
 * 源文本为空的应答不登记——那种结果里没有一个字是用户写的（纯运势、概率、限流
 * 提示），拿它去判反而是在判一段这个人没有发出去的文本。
 */
export function recordInlineResultSources(
  speakerId: number,
  sourceText: string,
  results: readonly InlineQueryResult[]
): void {
  if (sourceText.length === 0 || results.length === 0) return;
  const resultTexts: string[] = [];
  for (const result of results) {
    const text: string | undefined = inlineResultText(result);
    if (text !== undefined && text.length > 0) resultTexts.push(text);
  }
  if (resultTexts.length === 0) return;
  // 先删再写：Map 按插入序淘汰，重新登记的发言身份必须回到队尾，不被自己的旧
  // 位置提前挤掉。
  inlineResultSources.delete(speakerId);
  inlineResultSources.set(speakerId, { sourceText, resultTexts });
  while (inlineResultSources.size > INLINE_RESULT_SOURCE_MAX_AUTHORS) {
    const oldest: number | undefined = inlineResultSources.keys().next().value;
    if (oldest === undefined) break;
    inlineResultSources.delete(oldest);
  }
}

/**
 * 只在发送者自己的登记里按落群的结果正文取回源文本；没登记过或对不上一律
 * undefined，不查其它身份的登记。
 *
 * 逐字相同才认：客户端偶尔会发出上一次按键那条结果，那时宁可当作拿不到源文本，
 * 也不能拿另一段文本去判一条真实消息。
 */
export function inlineResultSourceOf(
  speakerId: number,
  resultText: string
): string | undefined {
  if (resultText.length === 0) return undefined;
  const source: InlineResultSource | undefined = inlineResultSources.get(speakerId);
  return source?.resultTexts.includes(resultText) === true ? source.sourceText : undefined;
}
