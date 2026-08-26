/**
 * `/query_qa` 看板：把本群已登记的问答铺成可复制的 JSON 代码块，并按长度分页。
 *
 * 看板是**用户明确授权的长期保留例外**（见 AGENTS.md「Telegram 提示留存」），
 * 不挂 30 秒清理；翻页按钮因此必须能在任意时刻工作，页码不进任何会话状态——
 * 每次点击都按 callback_data 里的页号从热表重新装页。这样重启、`/remove_qa`
 * 改动条目、甚至整群条目被清空之后，旧看板再点一下也会自己收敛到当前事实，
 * 而不是渲染一份早就不存在的快照。
 *
 * 答案在看板上**截断**到 QA_QUERY_ANSWER_PREVIEW_MAX_CHARS：看板是拿来扫一眼
 * 对照的，要完整答案原样问一次即可。问题**从不截断**——它是 `/remove_qa` 的
 * 入参，截断过的问题照抄回去什么也删不掉。
 */

import { InlineKeyboard, type Context } from "grammy";
import type { CallbackQuery } from "@grammyjs/types";
import {
  QA_COMMAND_TEXTS,
  QA_QUERY_ANSWER_PREVIEW_MAX_CHARS,
  QA_QUERY_JSON_LANGUAGE,
  QA_QUERY_PAGE_CALLBACK_PREFIX,
  QA_QUERY_PAGE_MAX_ENTRIES,
  QA_QUERY_PAGE_NEXT_TEXT,
  QA_QUERY_PAGE_NOOP_DATA,
  QA_QUERY_PAGE_PREV_TEXT,
  QA_TRUNCATION_MARK,
} from "../../consts/qa";
import { answerCallbackQuery, editMessageText } from "../../infra/telegram";
import { getChatQa } from "../../infra/qaStore";
import { truncateInline } from "../../libs/text";
import type { QaEntry } from "../../types/qa";
import type { RichTextMessage } from "../../types/telegram";

/** 看板上的一条答案：超出展示上限时截断并补省略号，总长仍在上限之内。 */
function answerPreview(answer: string): string {
  if (answer.length <= QA_QUERY_ANSWER_PREVIEW_MAX_CHARS) return answer;
  return truncateInline(
    answer,
    QA_QUERY_ANSWER_PREVIEW_MAX_CHARS - QA_TRUNCATION_MARK.length
  ) + QA_TRUNCATION_MARK;
}

/** 把一页条目渲染成「前缀 + json 代码块」；实体偏移按 UTF-16 code unit 计。 */
function renderQaBoardPage(entries: readonly QaEntry[]): RichTextMessage {
  const prefix: string = QA_COMMAND_TEXTS.queryPrefix;
  // 单条与多条都用数组：看板的形状必须稳定，读的人才能照着同一套结构抄。
  const json: string = JSON.stringify(entries, null, 2);
  return {
    text: `${prefix}${json}`,
    entities: [{
      type: "pre",
      offset: prefix.length,
      length: json.length,
      language: QA_QUERY_JSON_LANGUAGE,
    }],
  };
}

/**
 * 把条目按 QA_QUERY_PAGE_MAX_ENTRIES 条一页装页。
 *
 * 条数固定，因此每页装多少与条目长短无关：短问答不会挤成一整屏、让翻页条
 * 整个消失。单页不会超出 Telegram 上限的依据写在该常量的 JSDoc 里，这里因此
 * 不再对整页做一次 `JSON.stringify` 试装。
 */
export function buildQaBoardPages(entries: readonly QaEntry[]): readonly RichTextMessage[] {
  const pages: RichTextMessage[] = [];
  for (let start: number = 0; start < entries.length; start += QA_QUERY_PAGE_MAX_ENTRIES) {
    const bucket: QaEntry[] = [];
    const end: number = Math.min(start + QA_QUERY_PAGE_MAX_ENTRIES, entries.length);
    for (let index: number = start; index < end; index++) {
      const entry: QaEntry | undefined = entries[index];
      if (entry === undefined) continue;
      bucket.push({ q: entry.q, a: answerPreview(entry.a) });
    }
    if (bucket.length > 0) pages.push(renderQaBoardPage(bucket));
  }
  return pages;
}

/**
 * 翻页条；只有一页时返回 undefined，看板就是一条干净的消息。
 *
 * 首页不给「上一页」、末页不给「下一页」：Telegram 没有禁用态按钮，画一个点了
 * 没反应的按钮只会让人以为看板坏了。中间那颗是页码指示，点它什么都不做。
 */
export function buildQaBoardKeyboard(page: number, total: number): InlineKeyboard | undefined {
  if (total <= 1) return undefined;
  const keyboard: InlineKeyboard = new InlineKeyboard();
  if (page > 0) {
    keyboard.text(QA_QUERY_PAGE_PREV_TEXT, `${QA_QUERY_PAGE_CALLBACK_PREFIX}${page - 1}`);
  }
  keyboard.text(`${page + 1}/${total}`, QA_QUERY_PAGE_NOOP_DATA);
  if (page < total - 1) {
    keyboard.text(QA_QUERY_PAGE_NEXT_TEXT, `${QA_QUERY_PAGE_CALLBACK_PREFIX}${page + 1}`);
  }
  return keyboard;
}

/**
 * 处理看板翻页按钮的点击。
 *
 * @returns 是否由本领域认领。带本领域前缀的 callback 一律认领——哪怕页号解析
 *   失败或条目已被删光，也当场应答掉，绝不放给别的领域：不应答的话点的人只会
 *   看到按钮一直转。
 */
export async function handleQaBoardCallback(ctx: Context): Promise<boolean> {
  const query: CallbackQuery | undefined = ctx.callbackQuery;
  const data: string | undefined = query?.data;
  if (query === undefined || data === undefined) return false;
  if (!data.startsWith(QA_QUERY_PAGE_CALLBACK_PREFIX)) return false;
  await answerCallbackQuery({ callbackQueryId: query.id });
  // 页码指示按钮：目标状态就是当前状态，连编辑请求都不必发。
  if (data === QA_QUERY_PAGE_NOOP_DATA) return true;

  const boardMessage: CallbackQuery["message"] = query.message;
  if (boardMessage === undefined) return true;
  // callback_data 属于外部输入：前缀对上不代表后半段是合法页号。
  const requested: number = Number(data.slice(QA_QUERY_PAGE_CALLBACK_PREFIX.length));
  if (!Number.isSafeInteger(requested) || requested < 0) return true;

  const chatId: number = boardMessage.chat.id;
  const stored: ReadonlyMap<string, string> | undefined = getChatQa(chatId);
  const entries: QaEntry[] = [];
  if (stored !== undefined) for (const [q, a] of stored) entries.push({ q, a });
  const pages: readonly RichTextMessage[] = buildQaBoardPages(entries);
  if (pages.length === 0) {
    // 看板还挂着，条目却已经被删光：就地收敛成「空空如也」并收走翻页条，
    // 而不是留一份指向不存在条目的旧快照。
    await editMessageText({
      chatId,
      messageId: boardMessage.message_id,
      text: QA_COMMAND_TEXTS.queryEmpty,
    });
    return true;
  }
  // 条目变少时旧按钮上的页号可能已经越界，夹回现有范围而不是报错。
  const page: number = Math.min(requested, pages.length - 1);
  const rendered: RichTextMessage | undefined = pages[page];
  if (rendered === undefined) return true;
  await editMessageText({
    chatId,
    messageId: boardMessage.message_id,
    text: rendered.text,
    entities: rendered.entities,
    keyboard: buildQaBoardKeyboard(page, pages.length),
  });
  return true;
}
