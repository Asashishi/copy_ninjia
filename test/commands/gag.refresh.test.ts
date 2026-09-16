/** gag 专属入口的定时换新、消息阈值与结束竞态。 */
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  GAG_DURATION_MINUTES,
  GAG_SESSION_MAX,
  GAG_SPEAK_NOTICE_REFRESH_INTERVAL_MS,
} from "../../packages/consts/gag";
import type { GagSession } from "../../packages/types/gag";
import {
  addSession,
  commandContext,
  createSession,
  deleteEphemeralMessageWithOutcome,
  deleteMessageWithOutcome,
  gagSessionsByChat,
  gagBackgroundTasks,
  installGagTestHooks,
  normalMessage,
  resolveCommandTarget,
  sendCommandMessage,
  sendEphemeralMessage,
  sendMessage,
  sessionFor,
  settleGagBackgroundTasks,
} from "../helpers/gagHarness";
import type { EphemeralMessageParams } from "../helpers/gagHarness";

const gag = await import("../../packages/commands/gag");

installGagTestHooks();
beforeEach((): void => {
  jest.useFakeTimers({ now: 1_000_000 });
  Date.now = (): number => new Date().getTime();
  let nextNoticeId: number = 100;
  sendEphemeralMessage.mockImplementation(async (
    params: EphemeralMessageParams
  ): Promise<number> => {
    const noticeId: number = nextNoticeId++;
    params.onSent?.(noticeId);
    return noticeId;
  });
});
afterEach((): void => {
  gag.resetGagSessions();
  jest.useRealTimers();
});

async function advanceTime(milliseconds: number): Promise<void> {
  jest.advanceTimersByTime(milliseconds);
  await settleGagBackgroundTasks();
}

async function sendVisibleMessages(count: number): Promise<void> {
  for (let index: number = 0; index < count; index++) {
    await gag.handleGagMessageIngress(normalMessage({
      message_id: 200 + index,
      from: { id: 8, is_bot: false, first_name: "Bob" },
    }), 999);
    await settleGagBackgroundTasks();
  }
}

describe("gag 发言入口刷新", () => {
  test("满容量会话的发送阻塞时，千条群消息不会堆积等待刷新任务", async () => {
    for (let index: number = 0; index < GAG_SESSION_MAX; index++) {
      addSession(createSession({ targetId: 100 + index }));
    }
    const completions: (() => void)[] = [];
    sendEphemeralMessage.mockImplementation((
      params: EphemeralMessageParams
    ): Promise<number> => new Promise<number>((resolve: (id: number) => void): void => {
      completions.push((): void => {
        const noticeId: number = params.receiverUserId + 1_000;
        params.onSent?.(noticeId);
        resolve(noticeId);
      });
    }));
    for (let index: number = 0; index < 1_000; index++) {
      await gag.handleGagMessageIngress(normalMessage({
        message_id: 2_000 + index,
        from: { id: 8, is_bot: false, first_name: "Bob" },
      }), 999);
    }
    const pendingTaskCount: number = gagBackgroundTasks.size;
    const sendCount: number = sendEphemeralMessage.mock.calls.length;
    gag.quiesceGagRuntime();
    for (const complete of completions) complete();
    await settleGagBackgroundTasks();
    await gag.drainGagRuntime(1_000);
    expect(pendingTaskCount).toBeLessThanOrEqual(GAG_SESSION_MAX);
    expect(sendCount).toBe(GAG_SESSION_MAX);
    expect(gagBackgroundTasks.size).toBe(0);
    expect(gagSessionsByChat.size).toBe(0);
  });

  for (const durationMinutes of GAG_DURATION_MINUTES) {
    test(`${durationMinutes} 分钟内无人发言仍定时补发，到期才清理全部状态`, async () => {
      await gag.handleGagCommand(commandContext({ match: `@alice ${durationMinutes}` }));
      const session: GagSession = sessionFor(-1001)!;
      const expiresAt: number = session.expiresAt;
      expect(session.speakNoticeRefreshTimer?.hasRef()).toBeFalse();
      while (Date.now() + GAG_SPEAK_NOTICE_REFRESH_INTERVAL_MS < expiresAt) {
        const previousNoticeId: number = session.speakNoticeMessageId;
        await advanceTime(GAG_SPEAK_NOTICE_REFRESH_INTERVAL_MS);
        expect(session.phase).toBe("active");
        expect(session.speakNoticeMessageId).not.toBe(previousNoticeId);
        expect(session.expiresAt).toBe(expiresAt);
        expect(deleteEphemeralMessageWithOutcome).toHaveBeenLastCalledWith({
          chatId: -1001,
          receiverUserId: 7,
          ephemeralMessageId: previousNoticeId,
        });
        expect(sendCommandMessage).not.toHaveBeenCalled();
        expect(deleteMessageWithOutcome).not.toHaveBeenCalled();
      }
      // 功能入口按会话保留，不进入普通群提示的固定 30 秒清理边界。
      await advanceTime(expiresAt - Date.now() - 1);
      expect(sessionFor(-1001)).toBe(session);
      expect(session.speakNoticeMessageId).toBeGreaterThan(0);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const currentNoticeId: number = session.speakNoticeMessageId;
      const sendCount: number = sendEphemeralMessage.mock.calls.length;
      await advanceTime(1);
      expect(gagSessionsByChat.size).toBe(0);
      expect(session.speakNoticeRefreshTimer).toBeNull();
      expect(deleteEphemeralMessageWithOutcome).toHaveBeenLastCalledWith({
        chatId: -1001,
        receiverUserId: 7,
        ephemeralMessageId: currentNoticeId,
      });
      expect(deleteMessageWithOutcome).toHaveBeenCalledWith(-1001, 56);
      expect(sendCommandMessage).toHaveBeenCalledTimes(1);
      await advanceTime(GAG_SPEAK_NOTICE_REFRESH_INTERVAL_MS * 2);
      expect(sendEphemeralMessage).toHaveBeenCalledTimes(sendCount);
    });
  }

  test("第 6 条不刷新，第 7 条刷新，换新后重新计时且不延长 gag", async () => {
    await gag.handleGagCommand(commandContext());
    const session: GagSession = sessionFor(-1001)!;
    const expiresAt: number = session.expiresAt;
    await advanceTime(GAG_SPEAK_NOTICE_REFRESH_INTERVAL_MS / 2);
    await sendVisibleMessages(6);
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(1);
    await sendVisibleMessages(1);
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(2);
    expect(session.messagesSinceSpeakNotice).toBe(0);
    await advanceTime(GAG_SPEAK_NOTICE_REFRESH_INTERVAL_MS - 1);
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(2);
    await advanceTime(1);
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(3);
    expect(session.expiresAt).toBe(expiresAt);
  });

  test("定时补发失败保留现有入口，间隔到点重试，成功后才删除旧入口", async () => {
    await gag.handleGagCommand(commandContext());
    const session: GagSession = sessionFor(-1001)!;
    sendEphemeralMessage.mockResolvedValueOnce(undefined);
    await advanceTime(GAG_SPEAK_NOTICE_REFRESH_INTERVAL_MS);
    expect(session.speakNoticeMessageId).toBe(100);
    expect(deleteEphemeralMessageWithOutcome).not.toHaveBeenCalled();
    await advanceTime(GAG_SPEAK_NOTICE_REFRESH_INTERVAL_MS - 1);
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(2);
    await advanceTime(1);
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(3);
    expect(session.speakNoticeMessageId).toBe(101);
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledTimes(1);
  });

  test("定时换新与消息阈值并发只发送一次，跨话题后定时补发留在新话题", async () => {
    await gag.handleGagCommand(commandContext());
    const session: GagSession = sessionFor(-1001)!;
    let finishSend: (() => void) | undefined;
    sendEphemeralMessage.mockImplementationOnce((
      params: EphemeralMessageParams
    ): Promise<number> => new Promise<number>((resolve: (id: number) => void): void => {
      finishSend = (): void => {
        params.onSent?.(500);
        resolve(500);
      };
    }));
    jest.advanceTimersByTime(GAG_SPEAK_NOTICE_REFRESH_INTERVAL_MS);
    expect(finishSend).toBeDefined();
    for (let index: number = 0; index < 7; index++) {
      await gag.handleGagMessageIngress(normalMessage({
        message_id: 300 + index,
        from: { id: 8, is_bot: false, first_name: "Bob" },
      }), 999);
    }
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(2);
    expect(deleteEphemeralMessageWithOutcome).not.toHaveBeenCalled();
    finishSend!();
    await settleGagBackgroundTasks();
    expect(session.speakNoticeMessageId).toBe(500);
    await gag.handleGagMessageIngress(normalMessage({
      message_thread_id: 22,
      is_topic_message: true,
    }), 999);
    await settleGagBackgroundTasks();
    expect(session.speakNoticeThreadId).toBe(22);
    await advanceTime(GAG_SPEAK_NOTICE_REFRESH_INTERVAL_MS);
    expect(sendEphemeralMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      receiverUserId: 7,
      messageThreadId: 22,
    }));
  });

  test("到期接管定时补发中的迟到入口，不复活会话", async () => {
    await gag.handleGagCommand(commandContext());
    const session: GagSession = sessionFor(-1001)!;
    let finishSend: (() => void) | undefined;
    sendEphemeralMessage.mockImplementationOnce((
      params: EphemeralMessageParams
    ): Promise<number> => new Promise<number>((resolve: (id: number) => void): void => {
      finishSend = (): void => {
        params.onSent?.(500);
        resolve(500);
      };
    }));
    jest.advanceTimersByTime(GAG_SPEAK_NOTICE_REFRESH_INTERVAL_MS);
    jest.advanceTimersByTime(session.expiresAt - Date.now());
    expect(session.phase).toBe("ending");
    expect(session.speakNoticeRefreshTimer).toBeNull();
    finishSend!();
    await settleGagBackgroundTasks();
    expect(gagSessionsByChat.size).toBe(0);
    expect(deleteEphemeralMessageWithOutcome.mock.calls.map((call): number =>
      call[0].ephemeralMessageId
    )).toEqual([100, 500]);
    await advanceTime(GAG_SPEAK_NOTICE_REFRESH_INTERVAL_MS * 2);
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(2);
  });

  test("旧入口清理在途时停机等待同一任务，不再补发或重复删除", async () => {
    await gag.handleGagCommand(commandContext());
    const session: GagSession = sessionFor(-1001)!;
    session.retiredSpeakNoticeMessageId = 99;
    let finishDeletion: (() => void) | undefined;
    deleteEphemeralMessageWithOutcome.mockImplementationOnce(
      (): Promise<string> => new Promise<string>((resolve: (outcome: string) => void): void => {
        finishDeletion = (): void => resolve("deleted");
      })
    );
    jest.advanceTimersByTime(GAG_SPEAK_NOTICE_REFRESH_INTERVAL_MS);
    const draining: Promise<string> = gag.drainGagRuntime(1_000);
    expect(session.speakNoticeRefreshTimer).toBeNull();
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledTimes(1);
    finishDeletion!();
    expect(await draining).toBe("flushed");
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(1);
    expect(deleteEphemeralMessageWithOutcome.mock.calls.map((call): number =>
      call[0].ephemeralMessageId
    )).toEqual([99, 100]);
    await advanceTime(GAG_SPEAK_NOTICE_REFRESH_INTERVAL_MS);
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(1);
  });

  for (const ending of ["ungag", "teardown", "drain"] as const) {
    test(`${ending} 撤销定时换新并删除当前专属入口`, async () => {
      await gag.handleGagCommand(commandContext());
      const session: GagSession = sessionFor(-1001)!;
      if (ending === "ungag") await gag.handleUngagCommand(commandContext());
      else if (ending === "teardown") await gag.teardownGagInChat(-1001);
      else expect(await gag.drainGagRuntime(1_000)).toBe("flushed");
      expect(session.speakNoticeRefreshTimer).toBeNull();
      expect(sessionFor(-1001)).toBeUndefined();
      await advanceTime(GAG_SPEAK_NOTICE_REFRESH_INTERVAL_MS * 2);
      expect(sendEphemeralMessage).toHaveBeenCalledTimes(1);
      expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledTimes(1);
    });
  }

  test("频道公开入口不定时补发，仍在第 7 条群消息换新", async () => {
    resolveCommandTarget.mockResolvedValueOnce({
      id: -1002233445566,
      first_name: "频道",
      isChannel: true,
    });
    await gag.handleGagCommand(commandContext({ match: "-1002233445566" }));
    const session: GagSession = sessionFor(-1001, -1002233445566)!;
    expect(session.speakNoticeRefreshTimer).toBeNull();
    await advanceTime(GAG_SPEAK_NOTICE_REFRESH_INTERVAL_MS * 2);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await sendVisibleMessages(7);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendEphemeralMessage).not.toHaveBeenCalled();
  });
});
