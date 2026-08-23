/**
 * `/set_qa` 按钮表单的会话状态机。
 *
 * 会话**按群唯一**，只活在主线程内存里。两项填齐即结算：写进热表并排进 SQLite，
 * 然后删掉表单消息。到期由自己的 timer 结算，不留半张表单。
 *
 * 为什么不按发起人索引：见 types/qa.ts 的 QaFormSession——inline 查询永远来自
 * 真实用户账号，匿名管理员与频道身份在命令侧却是 `sender_chat`，两个 id 天然
 * 对不上。写入资格改由落群那一步重新校验权限决定。
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
 * 幂等：摘除前先确认表里那一项仍然是同一个对象，因此「两项填齐」与 TTL 到期
 * 撞在一起也不会重复摘除。表单消息的删除由调用方负责。
 */
export function closeQaFormSession(session: QaFormSession): void {
  if (session.timer !== null) {
    clearTimeout(session.timer);
    session.timer = null;
  }
  if (qaFormSessions.get(session.chatId) === session) {
    qaFormSessions.delete(session.chatId);
  }
}

/** 建立一张新表单的入参。 */
export interface OpenQaFormSessionParams {
  readonly chatId: number;
  /** 开表单的身份，只用于日志定位；不参与查找，也不决定谁能填。 */
  readonly openedById: number;
  /** 到期时的结算动作；由命令层提供，用来删掉表单消息。 */
  readonly onExpire: (session: QaFormSession) => void;
}

/**
 * 开一张新表单；同一群的旧表单先被结算掉。
 *
 * @returns 达到全局上限时返回 null——宁可当场说「现在满了」，也不悄悄踢掉别人
 *   正在填的那张：被顶掉的人只会看到自己的按钮突然不认了，无从排查。
 */
export function openQaFormSession({
  chatId,
  openedById,
  onExpire,
}: OpenQaFormSessionParams): QaFormSession | null {
  const previous: QaFormSession | undefined = qaFormSessions.get(chatId);
  if (previous !== undefined) closeQaFormSession(previous);
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
    onExpire(session);
  }, QA_FORM_SESSION_TTL_MS);
  // 半填的表单不该拖住进程退出：到点没人填完就该消失，不是需要落盘的状态。
  timer.unref?.();
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
