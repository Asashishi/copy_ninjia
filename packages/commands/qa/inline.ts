/**
 * `/set_qa` 表单的 inline 收集链路。
 *
 * 用户点按钮 -> Telegram 把当前输入框预填成 `qa_q:<群 id> ` -> 用户打字并选中
 * 结果 -> 结果作为一条 `via_bot` 消息落进群 -> 本模块认领它、取出文本、删掉那条
 * 消息，并把值写回表单会话。
 *
 * **认领判据全部来自 Telegram 给出的事实**：`via_bot` 是本机器人、正文以本领域
 * 标签开头、`message.chat.id` 确有未完成表单，且**发出这条结果的身份自己持有
 * `isCanControllQaPermission`**。查询前缀里的群 id 只用于让 inline 查询可解析，
 * 不参与鉴权——伪造它指向别的群，结果仍然落在伪造者自己所在的群，届时按那个群
 * 的表单与他自己的权限判定。
 *
 * 写入资格在这里再校验一次、而不是靠「谁开的表单」：inline 模式没有匿名概念，
 * 匿名管理员与频道身份开的表单，随后那条 inline 查询必然来自真实用户账号，
 * 两个 id 天然对不上（见 types/qa.ts 的 QaFormSession）。表单因此按群索引，
 * 而「谁有资格写」由落群这一步独立判定。
 */

import type { InlineQuery, InlineQueryResultArticle, Message } from "@grammyjs/types";
import { InlineQueryResultBuilder, type Context } from "grammy";
import {
  CHAT_QA_ANSWER_MAX_CHARS,
  CHAT_QA_QUESTION_MAX_CHARS,
  QA_ANSWER_BUTTON_TEXT,
  QA_INLINE_ANSWER_PREFIX,
  QA_INLINE_QUESTION_PREFIX,
  QA_QUESTION_BUTTON_TEXT,
} from "../../consts/qa";
import { hasWhitelistPermission } from "../../infra/identityPolicy/whitelist";
import { getQaThumbnailUrl } from "../../infra/storage/stateStore";
import { deleteMessageWithOutcome, logApiError } from "../../infra/telegram";
import { currentUpdateAbortSignal } from "../../infra/updateContext";
import { truncateInline } from "../../libs/text";
import type { QaFormSession } from "../../types/qa";
import { findQaFormSession } from "./session";
import { parseQaInlineResult, renderQaInlineResult } from "./rendering";

/** 解析出的表单查询：哪个字段、写给哪个群、内容是什么。 */
interface ParsedQaInlineQuery {
  readonly field: "q" | "a";
  readonly chatId: number;
  readonly value: string;
}

/** 首个空格前只接受规范的安全整数群 id；其它任何后缀一律拒绝。 */
function parseQaInlineQuery(query: string): ParsedQaInlineQuery | undefined {
  const field: "q" | "a" | undefined = query.startsWith(QA_INLINE_QUESTION_PREFIX)
    ? "q"
    : query.startsWith(QA_INLINE_ANSWER_PREFIX) ? "a" : undefined;
  if (field === undefined) return undefined;
  const prefixLength: number = field === "q"
    ? QA_INLINE_QUESTION_PREFIX.length
    : QA_INLINE_ANSWER_PREFIX.length;
  const separatorIndex: number = query.indexOf(" ", prefixLength);
  const scope: string = separatorIndex === -1
    ? query.slice(prefixLength)
    : query.slice(prefixLength, separatorIndex);
  const value: string = separatorIndex === -1 ? "" : query.slice(separatorIndex + 1);
  const chatId: number = Number(scope);
  if (scope.length === 0 || !Number.isSafeInteger(chatId)) return undefined;
  return { field, chatId, value: value.trim() };
}

/** 本领域是否要认领这条 inline 查询；前缀对上就认领，绝不退回运势。 */
export function isQaInlineQuery(query: string): boolean {
  return query.startsWith(QA_INLINE_QUESTION_PREFIX) ||
    query.startsWith(QA_INLINE_ANSWER_PREFIX);
}

function buildQaInlineResult(
  parsed: ParsedQaInlineQuery
): InlineQueryResultArticle {
  const label: string = parsed.field === "q" ? QA_QUESTION_BUTTON_TEXT : QA_ANSWER_BUTTON_TEXT;
  return InlineQueryResultBuilder.article(
    `qa-${parsed.field}-${parsed.chatId}`,
    `${label}：${truncateInline(parsed.value, 64)}`,
    { description: "选中即写入本群问答表单", thumbnail_url: getQaThumbnailUrl() }
  ).text(renderQaInlineResult(parsed.field, parsed.value), {
    link_preview_options: { is_disabled: true },
  });
}

/**
 * 应答表单的 inline 查询。
 *
 * @returns 是否由本领域认领。带本领域前缀的查询一律认领——哪怕解析失败或没有
 *   对应表单，也只回一份空结果，不能退回运势：那会让一次拼错的前缀变成抽签。
 */
export async function handleQaInlineQuery(ctx: Context): Promise<boolean> {
  const inlineQuery: InlineQuery | undefined = ctx.inlineQuery;
  if (inlineQuery === undefined || !isQaInlineQuery(inlineQuery.query)) return false;
  const parsed: ParsedQaInlineQuery | undefined = parseQaInlineQuery(inlineQuery.query);
  const results: InlineQueryResultArticle[] = [];
  if (parsed !== undefined && parsed.value.length > 0) {
    const limit: number = parsed.field === "q"
      ? CHAT_QA_QUESTION_MAX_CHARS
      : CHAT_QA_ANSWER_MAX_CHARS;
    // 表单必须真的存在才给结果。这一步纯粹是 UX 闸：它不写任何东西，因此不必
    // （也无法）在这里判定身份——inline 查询看不到当前群，鉴权留给落群那一步。
    const session: QaFormSession | undefined = findQaFormSession(parsed.chatId);
    if (session !== undefined && parsed.value.length <= limit) {
      results.push(buildQaInlineResult(parsed));
    }
  }
  try {
    await ctx.answerInlineQuery(
      results,
      { cache_time: 0, is_personal: true },
      currentUpdateAbortSignal() as unknown as
        Parameters<Context["answerInlineQuery"]>[2]
    );
  } catch (error: unknown) {
    logApiError("answerInlineQuery", error);
  }
  return true;
}

/** 一次落群认领的结果，交给命令层决定回执与是否结算表单。 */
export interface QaFormIngressResult {
  readonly session: QaFormSession;
  readonly field: "q" | "a";
  readonly value: string;
  /** 发出这条结果的身份是否持有维护权限；false 时值没有写进表单。 */
  readonly permitted: boolean;
}

/**
 * 认领落群的表单结果并写回会话。
 *
 * @returns 未认领时为 null；认领后消息已删除，调用方只需处理会话状态。
 */
export async function claimQaFormMessage(
  message: Message,
  botUserId: number
): Promise<QaFormIngressResult | null> {
  if (message.via_bot?.id !== botUserId) return null;
  const text: string | undefined = message.text;
  if (text === undefined) return null;
  const parsed: ReturnType<typeof parseQaInlineResult> = parseQaInlineResult(text);
  if (parsed === undefined) return null;
  const session: QaFormSession | undefined = findQaFormSession(message.chat.id);
  if (session === undefined) return null;

  // 认领之后立刻删掉这条中转消息：它只是把文本从 inline 模式带回来的载具，
  // 留在群里既没意义又会被后面的流水线当成普通消息。认领与写入分开：权限不足
  // 时这条消息同样要删掉（它已经没有别的用途了），但不落进表单。
  await deleteMessageWithOutcome(message.chat.id, message.message_id);

  // 与命令侧同一道口径：频道马甲一律拒绝（`sender_chat` 存在即是马甲），
  // 其余按真实用户身份判权限。两侧口径必须一致，否则命令挡住的身份能从这里绕进来。
  const writerId: number | undefined =
    message.sender_chat === undefined ? message.from?.id : undefined;
  if (writerId === undefined || !hasWhitelistPermission(writerId, "isCanControllQaPermission")) {
    return { session, field: parsed.field, value: parsed.value, permitted: false };
  }
  if (parsed.field === "q") session.q = parsed.value;
  else session.a = parsed.value;
  return { session, field: parsed.field, value: parsed.value, permitted: true };
}
