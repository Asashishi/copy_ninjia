import type {
  InlineQueryResult,
  InputMessageContent,
} from "@grammyjs/types";
import { inlineResultSources } from "../cache/main/inlineResultSources";
import { INLINE_RESULT_SOURCE_MAX_AUTHORS } from "../consts/telegram";

/**
 * 「本 bot 的 inline 结果 → 用户打进查询的源文本」登记表。
 *
 * **所有 inline 功能共用这一条通道**：结果正文由本 bot 渲染，用户真正写的字只
 * 存在于 inline 查询里，而 Telegram 不会把查询原文放进落群消息，也没有把消息与
 * 查询关联起来的字段。因此对应关系只能在应答那一刻登记，落群后按结果正文取回。
 *
 * 当前的读取方只有广告检测（见 antiRaid/adCandidate.ts）：它据此判用户自己写的
 * 那句话，而不是本 bot 的渲染结果。新增 inline 功能必须在应答处调用
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
 * 登记一次 inline 应答：整体覆盖该查询者上一次的登记。
 *
 * 传的就是即将交给 answerInlineQuery 的那份结果数组，正文由本函数取，调用方
 * 不必自己拼——渲染与登记之间不再有第二处需要保持一致的文本。
 *
 * inline 查询每敲一个键就来一次，只有最后一次应答里的结果才可能被发出去，因此
 * 不保留历史；同一次应答的多条结果（如同一个人在多个群同时被 gag）共享同一段
 * 源文本，必须一起登记，否则选中其中任意一条都会取不回源文本。
 * 源文本为空的应答不登记——那种结果里没有一个字是用户写的（纯运势、概率、限流
 * 提示），拿它去判反而是在判一段这个人没有发出去的文本。
 */
export function recordInlineResultSources(
  authorId: number,
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
  // 先删再写：Map 按插入序淘汰，重新登记的查询者必须回到队尾，不被自己的旧
  // 位置提前挤掉。
  inlineResultSources.delete(authorId);
  inlineResultSources.set(authorId, { sourceText, resultTexts });
  while (inlineResultSources.size > INLINE_RESULT_SOURCE_MAX_AUTHORS) {
    const oldest: number | undefined = inlineResultSources.keys().next().value;
    if (oldest === undefined) break;
    inlineResultSources.delete(oldest);
  }
}

/**
 * 按落群的结果正文取回源文本；没登记过或对不上一律 undefined。
 *
 * 逐字相同才认：客户端偶尔会发出上一次按键那条结果，那时宁可当作拿不到源文本，
 * 也不能拿另一段文本去判一条真实消息。表最多 INLINE_RESULT_SOURCE_MAX_AUTHORS
 * 条，且只有本 bot 的 inline 结果才会走到这里，扫一遍不进任何热路径。
 *
 * **按正文横扫全表、不按发送者取，是有意的**（调用点手上明明有 senderId）。改成
 * 按作者 O(1) 查会多出一条逃逸口：登记被容量挤掉、或发言发生在进程重启之后，
 * 本人那条就查不到了，而 antiRaid/adCandidate.ts 对 undefined 的处置是**整条不判**
 * ——想过审的广告只要制造这个条件就能绕开检测。正文逐字命中意味着送检的仍然是
 * 「有人为了得到这段结果而真的打进去的字」，拿它送检不会放过这条消息。
 * 代价是两个人的结果正文逐字相同时可能取回对方的查询原文；那是这里刻意选的一侧。
 */
export function inlineResultSourceOf(resultText: string): string | undefined {
  if (resultText.length === 0 || inlineResultSources.size === 0) return undefined;
  for (const source of inlineResultSources.values()) {
    if (source.resultTexts.includes(resultText)) return source.sourceText;
  }
  return undefined;
}
