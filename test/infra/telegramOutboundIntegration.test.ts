import { afterEach, beforeEach, expect, jest, mock, test } from "bun:test";
import type { Context, RawApi, Transformer } from "grammy";
import type { Update } from "grammy/types";
import { bot, initTelegramClients } from "../../packages/infra/telegram/mainClient";
import { telegramApi } from "../../packages/infra/telegram/client";
import { restoreDefaultProfilePhoto } from "../../packages/infra/telegram/avatar/restore";
import { downloadTelegramFileBytes } from "../../packages/infra/telegram/fileDownload";
import {
  handleAiWorkerTelegramRequest,
  handleAntiRaidWorkerTelegramRequest,
} from "../../packages/infra/telegram/workerRequests";
import {
  drainTelegramOutbound,
  initTelegramOutbound,
  telegramOutboundStats,
} from "../../packages/infra/telegram/outboundLifecycle";
import { loggerStub } from "../helpers/loggerMock";
import { deliverCronAction } from "../../packages/cron/delivery";
import { resolveCronGroupTargets } from "../../packages/cron/targets";
import type { CronAction, CronRoundDigests, CronRoundVoices, CronTaskSchedule } from "../../packages/types/cron";
import { chatStateCache } from "../../packages/cache/main/chatState";
import { chatStateOf } from "../helpers/chatState";
import { isSelfSent } from "../../packages/infra/selfSentTracker";
import { waitUntil } from "../helpers/waitUntil";
import { TELEGRAM_SEND_CHAT_BURST, TELEGRAM_SEND_CHAT_REFILL_MS } from "../../packages/consts/telegram";

mock.module("../../packages/infra/logger", () => ({ logger: loggerStub() }));

interface OutboundCall {
  readonly method: keyof RawApi;
  readonly payload: any;
  readonly signal: AbortSignal;
}

const calls: OutboundCall[] = [];
const originalFetch: typeof fetch = globalThis.fetch;
const image: Uint8Array = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let respond: (call: OutboundCall) => Promise<any> = successResponse;
let handleContext: (ctx: Context) => Promise<void> = async (): Promise<void> => {};
let messageId: number = 100;

async function successResponse({ method, payload }: OutboundCall): Promise<any> {
  if (method === "getMe") {
    return { ok: true, result: { id: 123, is_bot: true, first_name: "Test", username: "TestBot" } };
  }
  if (method === "getFile") {
    return { ok: true, result: { file_id: "file", file_unique_id: "unique", file_path: "test.png" } };
  }
  if (method === "sendMediaGroup") {
    return { ok: true, result: payload.media.map((): any => ({
      message_id: ++messageId, chat: { id: payload.chat_id, type: "supergroup" },
    })) };
  }
  return { ok: true, result: { message_id: ++messageId, chat: { id: -1001, type: "supergroup" } } };
}

// 在真实初始化链的最内层替换 HTTP；所有项目 transformer 和 SDK 入口照常执行。
const transport: Transformer<RawApi> = async (...args: Parameters<Transformer<RawApi>>): Promise<any> => {
  const [, method, payload, signal]: Parameters<Transformer<RawApi>> = args;
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(telegramOutboundStats().active).toBeGreaterThan(0);
  const call: OutboundCall = { method, payload, signal: signal as AbortSignal };
  calls.push(call);
  return respond(call);
};
bot.api.config.use(transport);
initTelegramClients();
await bot.init();
bot.use(async (ctx: Context): Promise<void> => handleContext(ctx));

const update: Update = {
  update_id: 1,
  message: {
    message_id: 1,
    date: 1,
    chat: { id: -1001, type: "supergroup", title: "Test" },
    from: { id: 7, is_bot: false, first_name: "Test" },
    text: "trigger",
  },
};

beforeEach((): void => {
  initTelegramOutbound();
  calls.length = 0;
  chatStateCache.clear();
  respond = successResponse;
  handleContext = async (): Promise<void> => {};
});

afterEach(async (): Promise<void> => {
  globalThis.fetch = originalFetch;
  await drainTelegramOutbound(0);
  chatStateCache.clear();
});

test("主线程、两类 Worker、ctx.reply 与 cron 共用同群发送队列，突发额度用完后按秒放行，排空等待包含排队", async (): Promise<void> => {
  jest.useFakeTimers();
  try {
    await sharedChatQueueScenario();
  } finally {
    jest.useRealTimers();
  }
});

/** 六路发送同群排队：先按顺序串行，前 TELEGRAM_SEND_CHAT_BURST 条连发，其余每隔一个补充周期放行一条。 */
async function sharedChatQueueScenario(): Promise<void> {
  const started: PromiseWithResolvers<void> = Promise.withResolvers();
  const release: PromiseWithResolvers<void> = Promise.withResolvers();
  const contextEntered: PromiseWithResolvers<void> = Promise.withResolvers();
  respond = async (call: OutboundCall): Promise<any> => {
    if (call.payload.text === "main") {
      started.resolve();
      await release.promise;
    }
    return successResponse(call);
  };
  const main: Promise<unknown> = telegramApi.sendMessage(-1001, "main");
  await started.promise;
  const ai: Promise<unknown> = handleAiWorkerTelegramRequest({
    operation: "call", category: "message",
    call: { method: "sendMessage", payload: { chat_id: -1001, text: "ai" } },
  }, new AbortController().signal);
  const antiRaid: Promise<unknown> = handleAntiRaidWorkerTelegramRequest({
    operation: "call", category: "message",
    call: { method: "sendMessage", payload: { chat_id: -1001, text: "antiRaid" } },
  }, new AbortController().signal);
  handleContext = async (ctx: Context): Promise<void> => {
    const reply: Promise<unknown> = ctx.reply("context");
    contextEntered.resolve();
    await reply;
  };
  const context: Promise<void> = bot.handleUpdate(update);
  await contextEntered.promise;
  const raw: Promise<unknown> = bot.api.raw.sendMessage({ chat_id: -1001, text: "raw" });
  const cron: Promise<unknown> = deliverCronAction({
    chatId: -1001, action: { type: "send_message", content: "cron" },
    signal: new AbortController().signal, voices: new Map(), digests: new Map(),
  });
  const requests: readonly Promise<unknown>[] = [main, ai, antiRaid, context, raw, cron];
  let settledCount: number = 0;
  for (const request of requests) void request.finally((): void => { settledCount++; });
  const settled: Promise<PromiseSettledResult<unknown>[]> = Promise.allSettled(requests);
  let drained: boolean = false;
  const totalSends: number = requests.length;
  const drain: Promise<unknown> = drainTelegramOutbound(
    (totalSends + 1) * TELEGRAM_SEND_CHAT_REFILL_MS
  ).then((result: unknown): unknown => {
    drained = true;
    return result;
  });
  try {
    expect(calls.map((call: OutboundCall): unknown => call.payload.text)).toEqual(["main"]);
    expect(telegramOutboundStats().messageActive).toBe(totalSends);
    expect(drained).toBe(false);
  } finally {
    release.resolve();
  }
  // 突发额度内的几条在 main 结算后立即连发，不用推进时钟。
  for (let tick: number = 0; tick < 50 && calls.length < TELEGRAM_SEND_CHAT_BURST; tick++) await Promise.resolve();
  expect(calls).toHaveLength(TELEGRAM_SEND_CHAT_BURST);
  for (let step: number = 0; step < totalSends && settledCount < totalSends; step++) {
    jest.advanceTimersByTime(TELEGRAM_SEND_CHAT_REFILL_MS);
    for (let tick: number = 0; tick < 50; tick++) await Promise.resolve();
  }
  expect((await settled).every((result: PromiseSettledResult<unknown>): boolean => result.status === "fulfilled")).toBe(true);
  await expect(drain).resolves.toBe("flushed");
  expect(calls.map((call: OutboundCall): unknown => call.payload.text)).toEqual(["main", "ai", "antiRaid", "context", "raw", "cron"]);
  expect(telegramOutboundStats().active).toBe(0);
}

test("cron 全部发送类型在所属聊天的发送队列等待 429 重放，成功后登记自发消息", async (): Promise<void> => {
  const voice: CronAction = { type: "send_voice", content: "voice", tone: undefined };
  const digest: CronAction = { type: "send_web_digest", topic: "news", language: "zh", maxItems: 1, instructions: undefined };
  const voices: CronRoundVoices = new Map([[voice, {
    voice: { bytes: new Uint8Array([0xff, 0xf3, 0x84, 0xc4]), fileName: "fixture.mp3", durationSeconds: 1 }, fileId: undefined,
  }]]);
  const digests: CronRoundDigests = new Map([[digest, "*news*"]]);
  const cases: readonly Readonly<{ action: CronAction; method: keyof RawApi }>[] = [
    { action: { type: "send_message", content: "cron" }, method: "sendMessage" },
    { action: { type: "send_image", content: "photo", source: { kind: "urls", urls: ["https://images.example/one.png"] }, isBlurred: true }, method: "sendPhoto" },
    { action: { type: "send_image", content: "album", source: { kind: "urls", urls: ["https://images.example/one.png", "https://images.example/two.png"] }, isBlurred: true }, method: "sendMediaGroup" },
    { action: { type: "send_file", content: undefined, source: { kind: "url", url: "https://files.example/document.pdf" } }, method: "sendDocument" },
    { action: voice, method: "sendVoice" },
    { action: digest, method: "sendMessage" },
  ];
  // 每种发送各用一个群：429 让本群进入保守档，换群使前一种的保守档不影响下一种。
  for (const [index, { action, method }] of cases.entries()) {
    const chatId: number = -1001 - index;
    calls.length = 0;
    let first: boolean = true;
    respond = async (call: OutboundCall): Promise<any> => {
      if (first) {
        first = false;
        return { ok: false, error_code: 429, description: "retry", parameters: { retry_after: 0.05 } };
      }
      return successResponse(call);
    };
    const delivery: Promise<unknown> = deliverCronAction({
      chatId, action, signal: new AbortController().signal, voices, digests,
    });
    await waitUntil((): boolean => telegramOutboundStats().messageRetryPending === 1);
    expect(telegramOutboundStats().messageRetryPending).toBe(1);
    expect(calls).toHaveLength(1);
    await expect(delivery).resolves.toEqual({ kind: "sent" });
    expect(calls.map((call: OutboundCall): string => call.method)).toEqual([method, method]);
    expect(calls.every((call: OutboundCall): boolean => call.payload.message_thread_id === undefined)).toBe(true);
    expect(isSelfSent(chatId, messageId)).toBe(true);
  }
});

test("cron 目标权限查询复用主线程 query 退避，成员与群默认权限查询都经过总闸", async (): Promise<void> => {
  chatStateCache.set(-1001, chatStateOf({ isInitEnabled: true }));
  const schedule: CronTaskSchedule = {
    task: {
      name: "cron-targets", chatTargets: { kind: "all" }, cron: "* * * * *", timeZone: "Asia/Tokyo",
      randomInterval: undefined, justOnce: false, actions: [{ type: "send_message", content: "cron" }],
    },
    job: null, cancelled: false,
  };
  let first: boolean = true;
  respond = async (call: OutboundCall): Promise<any> => {
    if (first) {
      first = false;
      return { ok: false, error_code: 429, description: "retry", parameters: { retry_after: 0.05 } };
    }
    if (call.method === "getChatMember") {
      return { ok: true, result: { status: "member", user: bot.botInfo } };
    }
    if (call.method === "getChat") {
      return { ok: true, result: { id: call.payload.chat_id, type: "supergroup", permissions: { can_send_messages: true } } };
    }
    return successResponse(call);
  };
  const targets: Promise<unknown> = resolveCronGroupTargets(schedule, [], new AbortController().signal);
  await waitUntil((): boolean => telegramOutboundStats().pending === 1);
  expect(telegramOutboundStats().pending).toBe(1);
  const main: Promise<unknown> = bot.api.getChat(-1002);
  expect(calls).toHaveLength(1);
  expect(telegramOutboundStats().pending).toBe(2);
  const results: PromiseSettledResult<unknown>[] = await Promise.allSettled([targets, main]);
  expect(results[0]).toEqual({ status: "fulfilled", value: { chatIds: [-1001], skipped: 0 } });
  expect(results[1]?.status).toBe("fulfilled");
  expect(calls.map((call: OutboundCall): readonly unknown[] => [call.method, call.payload.chat_id])).toEqual([
    ["getChatMember", -1001], ["getChatMember", -1001], ["getChat", -1002], ["getChat", -1001],
  ]);
});

test("cron 在 429 队列等待时停机取消，立即移除请求且不重发", async (): Promise<void> => {
  respond = async (): Promise<any> => ({
    ok: false, error_code: 429, description: "retry", parameters: { retry_after: 5 },
  });
  const controller: AbortController = new AbortController();
  const delivery: Promise<unknown> = deliverCronAction({
    chatId: -1001, action: { type: "send_message", content: "cron" },
    signal: controller.signal, voices: new Map(), digests: new Map(),
  });
  await waitUntil((): boolean => telegramOutboundStats().messageRetryPending === 1);
  expect(telegramOutboundStats().messageRetryPending).toBe(1);
  controller.abort();
  await expect(delivery).resolves.toEqual({ kind: "aborted" });
  expect(calls).toHaveLength(1);
  expect(telegramOutboundStats().messageRetryPending).toBe(0);
  expect(telegramOutboundStats().messageActive).toBe(0);
});

test("主线程查询的 429 同时暂停 Worker 与 ctx.api 查询，并保持接纳顺序", async (): Promise<void> => {
  let first: boolean = true;
  respond = async (call: OutboundCall): Promise<any> => {
    if (first) {
      first = false;
      return { ok: false, error_code: 429, description: "retry", parameters: { retry_after: 0.05 } };
    }
    return successResponse(call);
  };
  const main: Promise<unknown> = bot.api.getChat(-1001);
  // 原始 429 结算后，后续请求先进入同一条等待链。
  await waitUntil((): boolean => telegramOutboundStats().pending === 1);
  expect(telegramOutboundStats().pending).toBe(1);
  const worker: Promise<unknown> = handleAntiRaidWorkerTelegramRequest({
    operation: "call", category: "query",
    call: { method: "getChat", payload: { chat_id: -1002 } },
  }, new AbortController().signal);
  handleContext = async (ctx: Context): Promise<void> => { await ctx.api.getChat(-1003); };
  const context: Promise<void> = bot.handleUpdate(update);
  const settled: Promise<PromiseSettledResult<unknown>[]> = Promise.allSettled([main, worker, context]);
  await waitUntil((): boolean => telegramOutboundStats().pending === 3);
  expect(telegramOutboundStats().pending).toBe(3);
  expect(calls).toHaveLength(1);
  await expect(bot.api.deleteMessage(-1001, 1)).resolves.toBeDefined();
  expect(calls.at(-1)?.method).toBe("deleteMessage");
  expect((await settled).every((result: PromiseSettledResult<unknown>): boolean => result.status === "fulfilled")).toBe(true);
  expect(calls.filter((call: OutboundCall): boolean => call.method === "getChat")
    .map((call: OutboundCall): unknown => call.payload.chat_id)).toEqual([-1001, -1001, -1002, -1003]);
  await expect(drainTelegramOutbound(1_000)).resolves.toBe("flushed");
});

test("主线程管理、编辑、inline 应答和 SDK raw 调用均经过统一出站闸", async (): Promise<void> => {
  await bot.api.setMyCommands([]);
  await bot.api.deleteMyCommands();
  await bot.api.editMessageText(-1001, 1, "updated");
  await bot.api.answerInlineQuery("inline", []);
  await bot.api.raw.deleteEphemeralMessage({ chat_id: -1001, receiver_user_id: 7, ephemeral_message_id: 1 });
  expect(calls.map((call: OutboundCall): string => call.method)).toEqual([
    "setMyCommands", "deleteMyCommands", "editMessageText", "answerInlineQuery", "deleteEphemeralMessage",
  ]);
  expect(telegramOutboundStats().active).toBe(0);
});

test("默认头像 429 与 Telegram 文件下载共用 download 队列，重放释放旧响应体", async (): Promise<void> => {
  const downloads: string[] = [];
  let cancelled: number = 0;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(telegramOutboundStats().active).toBeGreaterThan(0);
    const url: string = String(input);
    downloads.push(url);
    if (downloads.length === 1) {
      expect(init?.redirect).toBe("follow");
      return new Response(new ReadableStream<Uint8Array>({ cancel(): void { cancelled++; } }), {
        status: 429, headers: { "retry-after": "0.05" },
      });
    }
    return new Response(image);
  }) as typeof fetch;
  const avatar: Promise<boolean> = restoreDefaultProfilePhoto({ kind: "url", url: "https://images.example/default.png" });
  await waitUntil((): boolean => telegramOutboundStats().pending === 1);
  expect(telegramOutboundStats().pending).toBe(1);
  const file: Promise<unknown> = downloadTelegramFileBytes({
    fileId: "file", maxBytes: 100, metadataTimeoutMs: 1_000, downloadTimeoutMs: 1_000, signal: undefined,
  });
  expect(downloads).toHaveLength(1);
  expect(calls.some((call: OutboundCall): boolean => call.method === "getFile")).toBe(false);
  const results: PromiseSettledResult<unknown>[] = await Promise.allSettled([avatar, file]);
  expect(results).toEqual([
    { status: "fulfilled", value: true },
    { status: "fulfilled", value: { status: "ok", bytes: image } },
  ]);
  expect(downloads.slice(0, 2)).toEqual(["https://images.example/default.png", "https://images.example/default.png"]);
  expect(downloads).toHaveLength(3);
  expect(cancelled).toBe(1);
});

test("默认头像下载在停机预算耗尽时取消真实 fetch，后续重试不再出站", async (): Promise<void> => {
  let requestSignal: AbortSignal | undefined;
  let downloads: number = 0;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    downloads++;
    requestSignal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  const avatar: Promise<boolean> = restoreDefaultProfilePhoto({ kind: "url", url: "https://images.example/default.png" });
  expect(telegramOutboundStats().active).toBe(1);
  await expect(drainTelegramOutbound(0)).resolves.toBe("timedOut");
  await expect(avatar).resolves.toBe(false);
  expect(requestSignal?.aborted).toBe(true);
  expect(downloads).toBe(1);
  expect(calls).toHaveLength(0);
  expect(telegramOutboundStats().active).toBe(0);
});

test("默认头像等待 429 时调用方取消，立即移除队列且不再下载或上传", async (): Promise<void> => {
  let downloads: number = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    downloads++;
    return new Response(null, { status: 429, headers: { "retry-after": "5" } });
  }) as unknown as typeof fetch;
  const controller: AbortController = new AbortController();
  const avatar: Promise<boolean> = restoreDefaultProfilePhoto({
    kind: "url", url: "https://images.example/default.png",
  }, controller.signal);
  await waitUntil((): boolean => telegramOutboundStats().pending === 1);
  expect(telegramOutboundStats().pending).toBe(1);
  controller.abort();
  await expect(avatar).resolves.toBe(false);
  expect(downloads).toBe(1);
  expect(calls).toHaveLength(0);
  expect(telegramOutboundStats().pending).toBe(0);
  await expect(drainTelegramOutbound(1_000)).resolves.toBe("flushed");
});
