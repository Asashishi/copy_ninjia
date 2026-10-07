/**
 * 入群验证提醒的投递 owner：发送在途期间成员状态被替换（已通过、离群或重建）时，
 * 迟到落地的提醒自删，且不再向状态机派发 reminderLanded。
 */

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import { settleTestBatch } from "../../helpers/common";

const TELEGRAM_API: { readonly kind: string } = { kind: "worker-api" };
let releaseSend: (messageId: number | undefined) => void = (): void => {};
const sendMessage = mock((_params: unknown): Promise<number | undefined> =>
  new Promise<number | undefined>((resolve: (value: number | undefined) => void): void => {
    releaseSend = resolve;
  })
);
const deleteMessage = mock(async (_chatId: number, _messageId: number, _api: unknown): Promise<boolean> => true);
mock.module("../../../packages/infra/telegram", () => ({
  sendMessage,
  deleteMessage,
  telegramApi: TELEGRAM_API,
}));
mock.module("../../../packages/infra/logger", () => ({ logger: loggerStub() }));

const { sendVerificationReminder, clearReminderDeliveries } =
  await import("../../../packages/workers/antiRaid/verificationReminders");
const { reminderDeliveries, verificationEntries } =
  await import("../../../packages/cache/workers/antiRaid/verification");
const { antiRaidInFlightTasks } = await import("../../../packages/cache/workers/antiRaid/tasks");

const CHAT_ID: number = -1001;
const USER_ID: number = 42;
const KEY: string = `${CHAT_ID}:${USER_ID}`;

function pendingState(): never {
  return {
    kind: "pending",
    label: "待验证成员",
    isBot: false,
    expiresAt: Date.now() + 60_000,
  } as never;
}

async function settleAntiRaidTasks(): Promise<void> {
  while (antiRaidInFlightTasks.size > 0) await settleTestBatch([...antiRaidInFlightTasks]);
}

beforeEach(() => {
  sendMessage.mockClear();
  deleteMessage.mockClear();
  verificationEntries.clear();
  clearReminderDeliveries();
});

afterEach(() => {
  verificationEntries.clear();
  clearReminderDeliveries();
});

test("提醒发送期间成员状态已被替换：迟到落地的提醒自删，不派发 reminderLanded", async () => {
  verificationEntries.set(KEY, { state: pendingState() } as never);
  const dispatchVerification = mock((..._args: unknown[]): void => {});
  sendVerificationReminder({
    chatId: CHAT_ID,
    userId: USER_ID,
    label: "待验证成员",
    isBot: false,
    dispatchVerification,
  });
  expect(sendMessage).toHaveBeenCalledTimes(1);

  verificationEntries.set(KEY, { state: { kind: "passed" } } as never);
  releaseSend(555);
  await settleAntiRaidTasks();

  expect(deleteMessage).toHaveBeenCalledWith(CHAT_ID, 555, TELEGRAM_API);
  expect(dispatchVerification).not.toHaveBeenCalled();
});

test("状态未变时落地的提醒交回状态机登记，不删除", async () => {
  verificationEntries.set(KEY, { state: pendingState() } as never);
  const dispatchVerification = mock((..._args: unknown[]): void => {});
  sendVerificationReminder({
    chatId: CHAT_ID,
    userId: USER_ID,
    label: "待验证成员",
    isBot: false,
    dispatchVerification,
  });

  releaseSend(556);
  await settleAntiRaidTasks();

  expect(deleteMessage).not.toHaveBeenCalled();
  expect(reminderDeliveries.has(KEY)).toBeFalse();
  expect(dispatchVerification).toHaveBeenCalledWith(CHAT_ID, USER_ID, expect.objectContaining({
    type: "reminderLanded",
    reminderKind: "original",
    messageId: 556,
  }));
});
