/**
 * `/set_qa` 表单的会话状态机。
 *
 * 会话**按群唯一**，只活在主线程内存里。两项填齐即结算：写进热表并排进 SQLite，
 * 然后删掉表单消息。到期由自己的 timer 关闭并交出删除责任。
 *
 * 表里按群索引、按 `openedById` 鉴权：同一群同时只有一张表单，而只有开表单的
 * 那个可见身份能往里填（见 types/qa.ts 的 QaFormSession 与 qa/ingress.ts）。
 */

import { qaFormSessions } from "../../cache/main/qa";
import { QA_FORM_SESSION_MAX, QA_FORM_SESSION_TTL_MS } from "../../consts/qa";
import type { QaFormSession } from "../../types/qa";

/** 取某群当前未完成的表单；没有则 undefined。 */
export function findQaFormSession(chatId: number): QaFormSession | undefined {
  return qaFormSessions.get(chatId);
}

/**
 * 结束一张表单：停掉 timer 并从表里摘掉。
 *
 * 返回是否关闭了当前会话；旧会话不能删除重开的新会话，也不能再次结算。
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
   * 表单被丢弃时的收尾动作；由命令层提供，用来删掉那条表单消息。
   *
   * 两条路径共用：TTL 到期，以及被同一个人重开的新表单顶掉。后者必须一起走
   * 这个回调——只把会话从表里摘掉的话，旧那条表单消息就再没有任何路径拥有它的
   * 删除责任，会永远留在群里，而它又不挂固定延迟清理（见 qa/notices.ts）。
   */
  readonly onDiscard: (session: QaFormSession) => void;
}

/**
 * 开一张新表单；同一群的旧表单连同它那条消息一起丢弃。
 *
 * 重开是**同一个人**的重来一次：已经填进去的问题和答案随旧会话一并作废，
 * 新表单从两项皆空开始。「别人正在填」由命令层在调用之前挡住，不到这里。
 *
 * @returns 达到全局上限时返回 null——宁可当场说「现在满了」，也不悄悄踢掉别人
 *   正在填的那张：被顶掉的人只会看到自己的表单突然不认了，无从排查。
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
  // 半填的表单不该拖住进程退出：到点没人填完就该消失，不是需要落盘的状态。
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
