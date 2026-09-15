/** gag 目标沉默后再次发言与定时、消息阈值刷新的组合语义。 */
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { GagSession } from "../../packages/types/gag";
import {
  addSession,
  commandContext,
  createSession,
  deleteEphemeralMessageWithOutcome,
  gagBackgroundTasks,
  installGagTestHooks,
  normalMessage,
  resolveCommandTarget,
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

async function speak(): Promise<void> {
  await gag.handleGagMessageIngress(normalMessage(), 999);
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

describe("gag 沉默后的发言补发", () => {
  test("30 秒照常补发，沉默满 45 秒发言立即补发，下一轮改在 75 秒", async () => {
    await gag.handleGagCommand(commandContext());
    const session: GagSession = sessionFor(-1001)!;
    const startedAt: number = Date.now();
    const expiresAt: number = session.expiresAt;
    await advanceTime(30_000);
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(2);
    expect(session.lastTargetMessageAt).toBe(startedAt);
    await advanceTime(15_000);
    await speak();
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(3);
    expect(session.lastTargetMessageAt).toBe(startedAt + 45_000);
    expect(session.speakNoticeRefreshTimer?.hasRef()).toBeFalse();
    await advanceTime(15_000);
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(3);
    await advanceTime(14_999);
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(3);
    await advanceTime(1);
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(4);
    expect(session.expiresAt).toBe(expiresAt);
    expect(session.lastTargetMessageAt).toBe(startedAt + 45_000);
  });

  test("44,999 毫秒不足沉默阈值，每次目标发言更新起点且不推迟定时补发", async () => {
    await gag.handleGagCommand(commandContext());
    await advanceTime(30_000);
    await advanceTime(14_999);
    await speak();
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(2);
    expect(sessionFor(-1001)!.lastTargetMessageAt).toBe(Date.now());
    await advanceTime(1);
    await speak();
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(2);
    await advanceTime(15_000);
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(3);
    await advanceTime(20_000);
    await speak();
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(3);
    await advanceTime(10_000);
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(4);
  });

  test("7 条消息独立刷新且不更新目标沉默时间", async () => {
    await gag.handleGagCommand(commandContext());
    const session: GagSession = sessionFor(-1001)!;
    const startedAt: number = Date.now();
    await advanceTime(10_000);
    await sendVisibleMessages(6);
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(1);
    await sendVisibleMessages(1);
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(2);
    expect(session.lastTargetMessageAt).toBe(startedAt);
    await advanceTime(30_000);
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(3);
    await advanceTime(5_000);
    await speak();
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(4);
    expect(session.messagesSinceSpeakNotice).toBe(0);
  });

  test("同一条目标媒体命中沉默阈值和第 7 条时只刷新一次", async () => {
    await gag.handleGagCommand(commandContext());
    await advanceTime(30_000);
    await advanceTime(15_000);
    await sendVisibleMessages(6);
    await gag.handleGagMessageIngress(normalMessage({
      text: undefined,
      photo: [{ file_id: "photo", file_unique_id: "unique", width: 1, height: 1 }],
    }), 999);
    await settleGagBackgroundTasks();
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(3);
    expect(sessionFor(-1001)!.messagesSinceSpeakNotice).toBe(0);
    expect(gagBackgroundTasks.size).toBe(0);
  });

  test("发言时间只更新本群本人的会话，其他人的发言不打断沉默", async () => {
    await gag.handleGagCommand(commandContext());
    const otherUser: GagSession = createSession({ targetId: 9 });
    const otherChat: GagSession = createSession({ chatId: -1002 });
    const startedAt: number = Date.now();
    addSession(otherUser);
    addSession(otherChat);
    await advanceTime(30_000);
    await sendVisibleMessages(1);
    await advanceTime(15_000);
    await speak();
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(3);
    expect(sendEphemeralMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      chatId: -1001,
      receiverUserId: 7,
    }));
    expect(otherUser.lastTargetMessageAt).toBe(startedAt);
    expect(otherChat.lastTargetMessageAt).toBe(startedAt);
    expect(otherUser.speakNoticeMessageId).toBe(55);
    expect(otherChat.speakNoticeMessageId).toBe(55);
  });

  test("定时请求阻塞期间回归发言与千条消息共享一个任务，完成后重设 30 秒", async () => {
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
    jest.advanceTimersByTime(30_000);
    jest.advanceTimersByTime(15_000);
    for (let index: number = 0; index < 1_000; index++) {
      await gag.handleGagMessageIngress(normalMessage({ message_id: 2_000 + index }), 999);
    }
    for (let index: number = 0; index < 7; index++) {
      await gag.handleGagMessageIngress(normalMessage({
        message_id: 3_000 + index,
        from: { id: 8, is_bot: false, first_name: "Bob" },
      }), 999);
    }
    const pendingCount: number = gagBackgroundTasks.size;
    const sendCount: number = sendEphemeralMessage.mock.calls.length;
    finishSend!();
    await settleGagBackgroundTasks();
    expect(pendingCount).toBe(1);
    expect(sendCount).toBe(2);
    expect(session.speakNoticeMessageId).toBe(500);
    expect(session.lastTargetMessageAt).toBe(Date.now());
    await advanceTime(15_000);
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(2);
    await advanceTime(15_000);
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(3);
  });

  test("回归发言补发失败不丢旧入口，不连续重发，30 秒后定时重试", async () => {
    await gag.handleGagCommand(commandContext());
    await advanceTime(30_000);
    await advanceTime(15_000);
    sendEphemeralMessage.mockResolvedValueOnce(undefined);
    await speak();
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(3);
    expect(sessionFor(-1001)!.speakNoticeMessageId).toBe(101);
    expect(deleteEphemeralMessageWithOutcome).toHaveBeenCalledTimes(1);
    await speak();
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(3);
    await advanceTime(15_000);
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(3);
    await advanceTime(15_000);
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(4);
    expect(sessionFor(-1001)!.speakNoticeMessageId).toBe(102);
  });

  test("到期接管回归发言补发中的迟到入口，不复活会话或 timer", async () => {
    await gag.handleGagCommand(commandContext());
    const session: GagSession = sessionFor(-1001)!;
    await advanceTime(30_000);
    await advanceTime(15_000);
    let finishSend: (() => void) | undefined;
    sendEphemeralMessage.mockImplementationOnce((
      params: EphemeralMessageParams
    ): Promise<number> => new Promise<number>((resolve: (id: number) => void): void => {
      finishSend = (): void => {
        params.onSent?.(500);
        resolve(500);
      };
    }));
    await gag.handleGagMessageIngress(normalMessage(), 999);
    jest.advanceTimersByTime(session.expiresAt - Date.now());
    expect(session.phase).toBe("ending");
    finishSend!();
    await settleGagBackgroundTasks();
    expect(sessionFor(-1001)).toBeUndefined();
    expect(session.speakNoticeRefreshTimer).toBeNull();
    expect(deleteEphemeralMessageWithOutcome.mock.calls.map((call): number =>
      call[0].ephemeralMessageId
    )).toEqual([100, 101, 500]);
    await advanceTime(60_000);
    await speak();
    expect(sendEphemeralMessage).toHaveBeenCalledTimes(3);
  });

  test("频道公开入口不走沉默补发，仍保留每 7 条刷新", async () => {
    resolveCommandTarget.mockResolvedValueOnce({
      id: -1002233445566,
      first_name: "频道",
      isChannel: true,
    });
    await gag.handleGagCommand(commandContext({ match: "-1002233445566" }));
    await advanceTime(45_000);
    await gag.handleGagMessageIngress(normalMessage({
      sender_chat: { id: -1002233445566, type: "channel", title: "频道" },
    }), 999);
    await settleGagBackgroundTasks();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await sendVisibleMessages(7);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendEphemeralMessage).not.toHaveBeenCalled();
  });
});
