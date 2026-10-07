/**
 * `/qa set` 表单的会话状态机。
 *
 * 会话按群唯一，只活在主线程内存里。两项填齐即结算：写进热表并排进 SQLite，
 * 然后删掉表单消息。到期由自己的 timer 关闭并交出删除责任。
 *
 * 表里按群索引、按 `openedById` 鉴权：只有开表单的那个可见身份能往里填
 * （见 types/qa.ts 的 QaFormSession 与 qa/ingress.ts）。
 */

import { qaFormSessions } from "../../cache/main/qa";
import { QA_FORM_SESSION_MAX, QA_FORM_SESSION_TTL_MS } from "../../consts/qa";
import type { QaFormSession } from "../../types/qa";

/**
 * 结束一张表单：停掉 timer 并从表里摘掉。
 *
 * 返回是否关闭了表里当前登记的会话；已被替换的旧会话返回 false，不能再次结算。
 * 表单消息的删除由调用方负责。
 */
export function closeQaFormSession(session: QaFormSession): boolean {
  if (session.timer !== null) {
    clearTimeout(session.timer);
    session.timer = null;
  }
  if (qaFormSessions.get(session.chatId) !== session) return false;
  qaFormSessions.delete(session.chatId);
  return true;
}

/** 建立一张新表单的入参。 */
export interface OpenQaFormSessionParams {
  readonly chatId: number;
  /** 开表单的可见身份；投递消息的身份必须与它相同才会被认领。 */
  readonly openedById: number;
  /**
   * 表单被丢弃时的收尾动作，由命令层提供，用来删掉那条表单消息。
   *
   * TTL 到期与被同一个人重开的新表单顶掉两条路径共用（表单不挂固定延迟清理，
   * 见 qa/notices.ts）。
   */
  readonly onDiscard: (session: QaFormSession) => void;
}

/**
 * 开一张新表单；同一群的旧表单连同它那条消息一起丢弃。
 *
 * 重开是同一个人的重来一次：已经填进去的问题和答案随旧会话一并作废，
 * 新表单从两项皆空开始；其他身份正在填的情形由命令层在调用之前挡住。
 *
 * @returns 达到 QA_FORM_SESSION_MAX 时返回 null，不挤掉其它群的表单。
 */
export function openQaFormSession({
  chatId,
  openedById,
  onDiscard,
}: OpenQaFormSessionParams): QaFormSession | null {
  const previous: QaFormSession | undefined = qaFormSessions.get(chatId);
  if (previous !== undefined) {
    closeQaFormSession(previous);
    onDiscard(previous);
  }
  if (qaFormSessions.size >= QA_FORM_SESSION_MAX) return null;

  const session: QaFormSession = {
    chatId,
    openedById,
    formMessageId: undefined,
    q: undefined,
    a: undefined,
    timer: null,
  };
  qaFormSessions.set(chatId, session);

  const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
    session.timer = null;
    closeQaFormSession(session);
    onDiscard(session);
  }, QA_FORM_SESSION_TTL_MS);
  // timer 不阻止进程退出；会话状态不落盘。
  timer.unref();
  session.timer = timer;
  return session;
}

/** 群 teardown / `/init disable`：清掉该群的表单并交给调用方收尾。 */
export function closeQaFormSessionsInChat(
  chatId: number,
  onClosed: (session: QaFormSession) => void
): void {
  const session: QaFormSession | undefined = qaFormSessions.get(chatId);
  if (session === undefined) return;
  closeQaFormSession(session);
  onClosed(session);
}
