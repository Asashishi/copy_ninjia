import type { AtmosphereTexts } from "../../types/atmosphere";
import { chatAtmosphere } from "../../infra/atmosphere";
/**
 * `/qa query` 看板：把本群已登记的问答铺成可复制的 JSON 代码块，并按条数分页。
 *
 * 看板是获授权的长期保留例外（见 docs/cn/04-invariants.md），不挂固定延迟清理；
 * 翻页按钮在任意时刻可用，页码不进任何会话状态——每次点击按 callback_data 里的
 * 页号从热表重新装页，条目变化或被清空后旧看板再点会收敛到当前内容。
 *
 * 答案在看板上截断到 QA_QUERY_ANSWER_PREVIEW_MAX_CHARS，完整答案按问题原样查询。
 * 问题从不截断，它是 `/qa remove` 的入参。
 */

import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import type { CallbackQuery } from "grammy/types";
import { QA_QUERY_ANSWER_PREVIEW_MAX_CHARS, QA_QUERY_JSON_INDENT, QA_QUERY_JSON_LANGUAGE, QA_QUERY_PAGE_ARG_PATTERN, QA_QUERY_PAGE_CALLBACK_PREFIX, QA_QUERY_PAGE_MAX_ENTRIES, QA_QUERY_PAGE_NOOP_DATA, QA_TRUNCATION_MARK } from "../../consts/qa";

import { answerCallbackQuery, editMessageText } from "../../infra/telegram";
import { chatQaEntries } from "../../cache/main/qa";
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
function renderQaBoardPage(entries: readonly QaEntry[], atmosphere: AtmosphereTexts): RichTextMessage {
  const prefix: string = atmosphere.QA_COMMAND_TEXTS.queryPrefix;
  // 单条与多条都用数组，看板结构一致。
  const json: string = JSON.stringify(entries, null, QA_QUERY_JSON_INDENT);
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
 * 每页条数与条目长短无关。单页不超出 Telegram 上限的依据见 QA_QUERY_PAGE_MAX_ENTRIES
 * 的 JSDoc。
 */
export function buildQaBoardPages(entries: readonly QaEntry[], atmosphere: AtmosphereTexts): readonly RichTextMessage[] {
  const pages: RichTextMessage[] = [];
  for (let start: number = 0; start < entries.length; start += QA_QUERY_PAGE_MAX_ENTRIES) {
    const bucket: QaEntry[] = [];
    const end: number = Math.min(start + QA_QUERY_PAGE_MAX_ENTRIES, entries.length);
    for (let index: number = start; index < end; index++) {
      const entry: QaEntry | undefined = entries[index];
      if (entry === undefined) continue;
      bucket.push({ q: entry.q, a: answerPreview(entry.a) });
    }
    if (bucket.length > 0) pages.push(renderQaBoardPage(bucket, atmosphere));
  }
  return pages;
}

/**
 * 翻页条；只有一页时返回 undefined，看板就是一条干净的消息。
 *
 * 首页不给「上一页」，末页不给「下一页」；中间是页码指示按钮（QA_QUERY_PAGE_NOOP_DATA），
 * 点击不做任何事。
 */
export function buildQaBoardKeyboard(page: number, total: number, atmosphere: AtmosphereTexts): InlineKeyboard | undefined {
  if (total <= 1) return undefined;
  const keyboard: InlineKeyboard = new InlineKeyboard();
  if (page > 0) {
    keyboard.text(atmosphere.QA_QUERY_PAGE_PREV_TEXT, `${QA_QUERY_PAGE_CALLBACK_PREFIX}${page - 1}`);
  }
  keyboard.text(`${page + 1}/${total}`, QA_QUERY_PAGE_NOOP_DATA);
  if (page < total - 1) {
    keyboard.text(atmosphere.QA_QUERY_PAGE_NEXT_TEXT, `${QA_QUERY_PAGE_CALLBACK_PREFIX}${page + 1}`);
  }
  return keyboard;
}

/**
 * 处理看板翻页按钮的点击。
 *
 * 没有 callback，或 data 不是本领域前缀时同步返回 false，不分配 Promise。
 * 带本领域前缀的 callback 一律认领并应答；页号解析失败、页码指示按钮或条目已被删光时同样如此。
 *
 * @returns 是否由本领域认领。
 */
export function handleQaBoardCallback(ctx: Context): boolean | Promise<boolean> {
  const query: CallbackQuery | undefined = ctx.callbackQuery;
  const data: string | undefined = query?.data;
  if (query === undefined || data === undefined) return false;
  if (!data.startsWith(QA_QUERY_PAGE_CALLBACK_PREFIX)) return false;
  return answerClaimedQaBoardCallback(query, data);
}

/** 已认领的翻页：先应答 callback，再按页号改写同一条看板消息。 */
async function answerClaimedQaBoardCallback(query: CallbackQuery, data: string): Promise<boolean> {
  await answerCallbackQuery({ callbackQueryId: query.id });
  // 页码指示按钮：不发编辑请求。
  if (data === QA_QUERY_PAGE_NOOP_DATA) return true;

  const boardMessage: CallbackQuery["message"] = query.message;
  if (boardMessage === undefined) return true;
  // callback_data 属于外部输入：后半段须匹配 QA_QUERY_PAGE_ARG_PATTERN 且为安全整数，
  // 否则只应答、不编辑。
  const rawPage: string = data.slice(QA_QUERY_PAGE_CALLBACK_PREFIX.length);
  if (!QA_QUERY_PAGE_ARG_PATTERN.test(rawPage)) return true;
  const requested: number = Number(rawPage);
  if (!Number.isSafeInteger(requested)) return true;

  const chatId: number = boardMessage.chat.id;
  const stored: ReadonlyMap<string, string> | undefined = chatQaEntries.get(chatId);
  const entries: QaEntry[] = [];
  if (stored !== undefined) for (const [q, a] of stored) entries.push({ q, a });
  const atmosphere: AtmosphereTexts = chatAtmosphere();
  const pages: readonly RichTextMessage[] = buildQaBoardPages(entries, atmosphere);
  if (pages.length === 0) {
    // 条目已被删光：就地改成 queryEmpty 并收走翻页条。
    await editMessageText({
      chatId,
      messageId: boardMessage.message_id,
      text: atmosphere.QA_COMMAND_TEXTS.queryEmpty,
    });
    return true;
  }
  // 页号越界时夹回现有范围。
  const page: number = Math.min(requested, pages.length - 1);
  const rendered: RichTextMessage | undefined = pages[page];
  if (rendered === undefined) return true;
  await editMessageText({
    chatId,
    messageId: boardMessage.message_id,
    text: rendered.text,
    entities: rendered.entities,
    keyboard: buildQaBoardKeyboard(page, pages.length, atmosphere),
  });
  return true;
}
