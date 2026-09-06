import { beforeEach, expect, mock, test } from "bun:test";
import type { Mock } from "bun:test";
import type { QaFormSession } from "../../packages/types/qa";
import type * as MessageLifecycle from "../../packages/infra/telegram/actions/messageLifecycle";
import type * as QaNotices from "../../packages/commands/qa/notices";

const logApiError: Mock<(...args: unknown[]) => void> = mock((..._args: unknown[]): void => {});
const deleteMessage: Mock<(chatId: number, messageId: number) => Promise<true>> = mock(async (_chatId: number, _messageId: number): Promise<true> => true);
mock.module("../../packages/infra/telegram/client", (): Record<string, unknown> => ({ telegramApi: { deleteMessage }, logApiError }));
const { deleteMessageWithOutcome }: typeof MessageLifecycle = await import("../../packages/infra/telegram/actions/messageLifecycle");
mock.module("../../packages/infra/telegram", (): Record<string, unknown> => ({
  deleteMessageWithOutcome,
  editMessageText: async (): Promise<boolean> => true,
  sendMessage: async (): Promise<number | undefined> => undefined,
}));
const { deleteQaForm }: typeof QaNotices = await import("../../packages/commands/qa/notices");

function session(): QaFormSession {
  return { chatId: -1001, openedById: 42, formMessageId: 55, q: undefined, a: undefined, timer: null };
}

beforeEach((): void => {
  deleteMessage.mockClear();
  logApiError.mockClear();
});

test("删除失败经过真实 Telegram 错误边界记录一次，重复清理不重复发请求", async (): Promise<void> => {
  const failure: Error = new Error("fixture failure");
  deleteMessage.mockImplementationOnce(async (): Promise<never> => { throw failure; });
  const form: QaFormSession = session();
  await deleteQaForm(form);
  await deleteQaForm(form);
  expect(form.formMessageId).toBeUndefined();
  expect(deleteMessage).toHaveBeenCalledTimes(1);
  expect(logApiError.mock.calls).toEqual([["delete message", failure]]);
});

test("删除尚未完成时重复清理只交出一次消息 id", async (): Promise<void> => {
  const pending: PromiseWithResolvers<true> = Promise.withResolvers<true>();
  deleteMessage.mockImplementationOnce((): Promise<true> => pending.promise);
  const form: QaFormSession = session();
  const first: Promise<void> = deleteQaForm(form);
  await deleteQaForm(form);
  expect(deleteMessage).toHaveBeenCalledTimes(1);
  pending.resolve(true);
  await first;
  expect(logApiError).not.toHaveBeenCalled();
});
