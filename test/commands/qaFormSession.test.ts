import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  QA_FORM_SESSION_MAX,
  QA_FORM_SESSION_TTL_MS,
} from "../../packages/consts/qa";
import { qaFormSessions, resetChatQaCache } from "../../packages/cache/main/qa";
import {
  closeQaFormSession,
  closeQaFormSessionsInChat,
  findQaFormSession,
  openQaFormSession,
} from "../../packages/commands/qa/session";
import type { QaFormSession } from "../../packages/types/qa";

const CHAT_ID: number = -1001;
const OWNER_ID: number = 42;
const noop: (session: QaFormSession) => void = (): void => {};

beforeEach((): void => {
  resetChatQaCache();
});
afterEach((): void => {
  resetChatQaCache();
});

describe("/set_qa 表单会话", () => {
  test("按群唯一：同一群重开会替换掉旧的那张", () => {
    const first: QaFormSession | null = openQaFormSession({
      chatId: CHAT_ID,
      openedById: OWNER_ID,
      onDiscard: noop,
    });
    first!.q = "旧问题";

    const second: QaFormSession | null = openQaFormSession({
      chatId: CHAT_ID,
      openedById: OWNER_ID,
      onDiscard: noop,
    });

    expect(second).not.toBe(first);
    expect(second!.q).toBeUndefined();
    expect(findQaFormSession(CHAT_ID)).toBe(second!);
    expect(qaFormSessions.size).toBe(1);
  });

  test("查找只按群，不看发起人：匿名管理员开的表单也找得到", () => {
    // 命令侧的 sender_chat 是本群，因此 openedById 就是群 id；随后那条 inline
    // 查询来自真实用户账号。按人索引的话这张表单永远填不了。
    openQaFormSession({ chatId: CHAT_ID, openedById: CHAT_ID, onDiscard: noop });

    expect(findQaFormSession(CHAT_ID)).toBeDefined();
  });

  test("达到全局上限后拒绝新建，而不是踢掉别人正在填的那张", () => {
    for (let index: number = 0; index < QA_FORM_SESSION_MAX; index++) {
      expect(openQaFormSession({ chatId: -index - 1, openedById: 1, onDiscard: noop }))
        .not.toBeNull();
    }

    // 被顶掉的人只会看到自己的按钮突然不认了，无从排查；宁可当场说满了。
    expect(openQaFormSession({ chatId: -99999, openedById: 1, onDiscard: noop })).toBeNull();
    expect(qaFormSessions.size).toBe(QA_FORM_SESSION_MAX);
  });

  test("结算是幂等的", () => {
    const session: QaFormSession = openQaFormSession({
      chatId: CHAT_ID,
      openedById: OWNER_ID,
      onDiscard: noop,
    })!;

    closeQaFormSession(session);
    closeQaFormSession(session);

    expect(qaFormSessions.size).toBe(0);
    expect(findQaFormSession(CHAT_ID)).toBeUndefined();
  });

  test("teardown 只清本群，别的群不受影响", () => {
    openQaFormSession({ chatId: CHAT_ID, openedById: 1, onDiscard: noop });
    openQaFormSession({ chatId: -1002, openedById: 3, onDiscard: noop });
    const closed: number[] = [];

    closeQaFormSessionsInChat(CHAT_ID, (session: QaFormSession): void => {
      closed.push(session.chatId);
    });

    expect(closed).toEqual([CHAT_ID]);
    expect(findQaFormSession(CHAT_ID)).toBeUndefined();
    expect(findQaFormSession(-1002)).toBeDefined();
  });

  test("整表复位清掉全部会话", () => {
    openQaFormSession({ chatId: CHAT_ID, openedById: OWNER_ID, onDiscard: noop });

    resetChatQaCache();

    expect(qaFormSessions.size).toBe(0);
  });

  test("TTL 到期自行结算并交回会话，让调用方删掉表单消息", () => {
    // 半填的表单不该永远挂在群里：到点由会话自己的 timer 摘表 + 回调收走那条
    // 按钮消息（commands/qa.ts 的 discardQaForm），不依赖任何外部扫描。
    jest.useFakeTimers();
    try {
      const expired: QaFormSession[] = [];
      const session: QaFormSession = openQaFormSession({
        chatId: CHAT_ID,
        openedById: OWNER_ID,
        onDiscard: (closed: QaFormSession): void => { expired.push(closed); },
      })!;
      session.q = "只填了问题";

      jest.advanceTimersByTime(QA_FORM_SESSION_TTL_MS - 1);
      expect(expired).toHaveLength(0);
      expect(findQaFormSession(CHAT_ID)).toBe(session);

      jest.advanceTimersByTime(1);

      expect(expired).toEqual([session]);
      expect(session.timer).toBeNull();
      expect(findQaFormSession(CHAT_ID)).toBeUndefined();
      expect(qaFormSessions.size).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test("到期前填齐即结算的表单不会再触发过期回调", () => {
    jest.useFakeTimers();
    try {
      const expired: QaFormSession[] = [];
      const session: QaFormSession = openQaFormSession({
        chatId: CHAT_ID,
        openedById: OWNER_ID,
        onDiscard: (closed: QaFormSession): void => { expired.push(closed); },
      })!;

      closeQaFormSession(session);
      jest.advanceTimersByTime(QA_FORM_SESSION_TTL_MS * 2);

      expect(expired).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
