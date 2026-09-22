/** 欢迎语经真实双工协议与主线程发送/删除边界，Telegram 出站由 SDK transformer 替换。 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import type { Mock } from "bun:test";
import { Api } from "grammy";
import type { Transformer } from "grammy";
import { COMMAND_MESSAGE_AUTO_DELETE_MS } from "../../../packages/consts/commands";
import { pendingMessageDeletions } from "../../../packages/cache/perThread/messageDeletion";
import { workerDuplexWaiters } from "../../../packages/cache/perThread/workerDuplex";
import {
  handleWorkerDuplexResponse,
  initializeWorkerDuplex,
  resetWorkerDuplex,
  setWorkerDuplexRequestSignal,
} from "../../../packages/libs/workerDuplex";
import { applyWorkerAtmosphere } from "../../../packages/workers/antiRaid/atmosphere";
import type { PendingMessageDeletion } from "../../../packages/types/telegram";
import type { TelegramApi, TelegramWorkerRequest } from "../../../packages/types/telegramWorker";
import type { VerificationEffect } from "../../../packages/types/states/verification";
import type { WorkerDuplexOutbound, WorkerDuplexRequest } from "../../../packages/types/workerDuplex";
import type * as TelegramClientModule from "../../../packages/infra/telegram/client";
import type * as TelegramRequestsModule from "../../../packages/infra/telegram/workerRequests";
import type * as VerificationEffectsModule from "../../../packages/workers/antiRaid/verificationEffects";
import type * as MessageLifecycleModule from "../../../packages/infra/telegram/actions/messageLifecycle";

async function answerTelegram(method: string, payload: Record<string, unknown>): Promise<any> {
  return {
    ok: true,
    result: method === "sendMessage"
      ? { message_id: 912, date: 1, chat: { id: payload.chat_id, type: "supergroup" }, text: payload.text }
      : true,
  };
}
const telegramRequest: Mock<typeof answerTelegram> = mock(answerTelegram);
const api: Api = new Api("123456789:test-only-telegram-token");
api.config.use((...args: Parameters<Transformer>): Promise<any> => telegramRequest(args[1], args[2]));
const logError: Mock<(...args: unknown[]) => void> = mock((..._args: unknown[]): void => {});
mock.module("../../../packages/infra/telegram/mainClient", (): object => ({ bot: { api } }));
mock.module("../../../packages/infra/logger", (): object => ({
  logger: loggerStub({ error: logError }),
}));

const { installTelegramApi }: typeof TelegramClientModule =
  await import("../../../packages/infra/telegram/client");
installTelegramApi(api as unknown as TelegramApi);
const { handleAntiRaidWorkerTelegramRequest }: typeof TelegramRequestsModule =
  await import("../../../packages/infra/telegram/workerRequests");
const { runVerificationEffects }: typeof VerificationEffectsModule =
  await import("../../../packages/workers/antiRaid/verificationEffects");
const { drainPendingMessageDeletions, resetPendingMessageDeletions }: typeof MessageLifecycleModule =
  await import("../../../packages/infra/telegram/actions/messageLifecycle");

const outbound: WorkerDuplexOutbound<TelegramWorkerRequest>[] = [];
function startTransport(): void {
  initializeWorkerDuplex<TelegramWorkerRequest>((message: WorkerDuplexOutbound<TelegramWorkerRequest>): void => {
    outbound.push(message);
  });
}

function run(effects: VerificationEffect[]): Promise<void> {
  return runVerificationEffects({
    chatId: -1001,
    userId: 123,
    effects,
    dispatchVerification(): void {},
    publishVerificationChange(): void {},
  });
}

function request(): WorkerDuplexRequest<TelegramWorkerRequest> {
  const envelope: WorkerDuplexOutbound<TelegramWorkerRequest> | undefined = outbound[0];
  if (envelope?.__duplex !== "request") throw new Error("Missing Worker request");
  return envelope;
}

function reply(envelope: WorkerDuplexRequest<TelegramWorkerRequest>, value: unknown): void {
  handleWorkerDuplexResponse({ __duplex: "response", requestId: envelope.requestId, ok: true, value, error: undefined });
}

beforeEach((): void => {
  outbound.length = 0;
  telegramRequest.mockReset().mockImplementation(answerTelegram);
  logError.mockReset().mockImplementation((..._args: unknown[]): void => {});
  applyWorkerAtmosphere(-1001, true);
  startTransport();
});

afterEach((): void => {
  resetWorkerDuplex("test cleanup");
  resetPendingMessageDeletions();
});

const welcomes: readonly Readonly<{
  variant: Extract<VerificationEffect, { kind: "sendWelcome" }>["variant"];
  text: string;
}>[] = [
  { variant: "verified", text: "Alice 已通过入群验证，欢迎加入。" },
  { variant: "approved", text: "管理员 Alice 已为 Bob 通过入群验证，欢迎加入。" },
  { variant: "vouchedBot", text: "管理员 Alice 已为机器人 Bob 通过入群验证。" },
  { variant: "channelComment", text: "Bob 已通过帖子评论身份检查，免除入群验证，欢迎加入。" },
];

for (const welcome of welcomes) {
  test(`欢迎语 ${welcome.variant} 保持文案、回复锚点与 30 秒清理`, async (): Promise<void> => {
    const completion: Promise<void> = run([{
      kind: "sendWelcome", variant: welcome.variant, fromLabel: "Alice", targetLabel: "Bob", anchorMessageId: 77,
    }]);
    const envelope: WorkerDuplexRequest<TelegramWorkerRequest> = request();
    expect(envelope.request).toMatchObject({ operation: "sendTemporaryMessage", purpose: "notice", replyToMessageId: 77, deleteAfterMs: COMMAND_MESSAGE_AUTO_DELETE_MS });
    const result: unknown = await handleAntiRaidWorkerTelegramRequest(envelope.request, new AbortController().signal);
    expect(telegramRequest).toHaveBeenCalledTimes(1);
    expect(telegramRequest).toHaveBeenCalledWith("sendMessage", expect.objectContaining({
      chat_id: -1001, text: welcome.text, reply_parameters: { message_id: 77, allow_sending_without_reply: true },
    }));
    expect(pendingMessageDeletions.size).toBe(1);
    const entry: PendingMessageDeletion = [...pendingMessageDeletions][0]!;
    expect(entry).toMatchObject({ chatId: -1001, messageId: 912, batchOnFlush: true });
    expect(entry.timer.hasRef()).toBeFalse();
    reply(envelope, result);
    await completion;
    expect(workerDuplexWaiters.size).toBe(0);
    expect(pendingMessageDeletions.size).toBe(1);
  });
}

for (const interruption of ["cancel", "teardown"] as const) {
  test(`远端成功后 ${interruption} 丢弃回执，主线程仍兑现一次删除`, async (): Promise<void> => {
    const lifecycle: AbortController = new AbortController();
    setWorkerDuplexRequestSignal(lifecycle.signal);
    const completion: Promise<void> = run([{ kind: "sendWelcome", variant: "channelComment", targetLabel: "Bob" }]);
    const envelope: WorkerDuplexRequest<TelegramWorkerRequest> = request();
    const result: unknown = await handleAntiRaidWorkerTelegramRequest(envelope.request, lifecycle.signal);
    expect(telegramRequest.mock.calls[0]?.[1].reply_parameters).toBeUndefined();
    expect(pendingMessageDeletions.size).toBe(1);
    if (interruption === "cancel") lifecycle.abort();
    else resetWorkerDuplex("Worker stopped before response delivery");
    await completion;
    expect(workerDuplexWaiters.size).toBe(0);
    reply(envelope, result);
    startTransport();
    expect(pendingMessageDeletions.size).toBe(1);
    await expect(drainPendingMessageDeletions(1_000)).resolves.toBe("flushed");
    expect(pendingMessageDeletions.size).toBe(0);
    expect(telegramRequest.mock.calls.map(([method]: [string, Record<string, unknown>]): string => method)).toEqual(["sendMessage", "deleteMessages"]);
    expect(telegramRequest.mock.calls[1]?.[1]).toEqual({ chat_id: -1001, message_ids: [912] });
  });
}

test("Telegram 发送失败不登记删除，后续验证副作用继续执行", async (): Promise<void> => {
  telegramRequest.mockImplementationOnce(async (): Promise<never> => { throw new Error("mock send failed"); });
  const completion: Promise<void> = run([
    { kind: "sendWelcome", variant: "channelComment", targetLabel: "Bob" },
    { kind: "answerCallback", callbackQueryId: "after-failure", reply: "ok" },
  ]);
  const envelope: WorkerDuplexRequest<TelegramWorkerRequest> = request();
  const result: unknown = await handleAntiRaidWorkerTelegramRequest(envelope.request, new AbortController().signal);
  expect(result).toBeUndefined();
  expect(pendingMessageDeletions.size).toBe(0);
  reply(envelope, result);
  await completion;
  expect(logError).toHaveBeenCalledTimes(1);
  expect(telegramRequest.mock.calls.map(([method]: [string, Record<string, unknown>]): string => method)).toEqual(["sendMessage", "answerCallbackQuery"]);
});

test("双工传输失败经统一错误边界记录，后续验证副作用继续执行", async (): Promise<void> => {
  initializeWorkerDuplex((): never => { throw new Error("mock transport failed"); });
  await run([
    { kind: "sendWelcome", variant: "channelComment", targetLabel: "Bob" },
    { kind: "answerCallback", callbackQueryId: "after-failure", reply: "ok" },
  ]);
  expect(pendingMessageDeletions.size).toBe(0);
  expect(logError).toHaveBeenCalledTimes(1);
  expect(telegramRequest.mock.calls.map(([method]: [string, Record<string, unknown>]): string => method)).toEqual(["answerCallbackQuery"]);
});
