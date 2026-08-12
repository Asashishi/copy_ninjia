import { describe, expect, mock, test } from "bun:test";

const botUse = mock((..._args: unknown[]): void => {});
const loggerError = mock((..._args: unknown[]): void => {});
const apiThrottler = mock((..._args: unknown[]) => ({ kind: "throttler" }));
const OVERFLOW_STRATEGY: number = 3;
const hydrateFiles = mock((token: string) => ({ kind: "files", token }));
const telegramOutboundGate = mock(() => ({ kind: "outbound-gate" }));
const initTelegramOutbound = mock((): void => {});
const mainSendPhoto = mock(async (..._args: unknown[]) => ({ message_id: 19 }));
let botConstructions: number = 0;

class FakeGrammyError extends Error {
  constructor(
    _message: string,
    readonly error: { error_code: number; description: string }
  ) {
    super(_message);
  }

  get error_code(): number {
    return this.error.error_code;
  }

  get description(): string {
    return this.error.description;
  }
}

class FakeBot {
  readonly api = { config: { use: botUse }, sendPhoto: mainSendPhoto };
  constructor(readonly token: string) {
    botConstructions++;
  }
}

class FakeApi {
  constructor(readonly token: string) {}
}

class FakeInputFile {
  constructor(
    readonly bytes: Uint8Array,
    readonly fileName: string
  ) {}
}

mock.module("grammy", () => ({
  Api: FakeApi,
  Bot: FakeBot,
  GrammyError: FakeGrammyError,
  InputFile: FakeInputFile,
}));
mock.module("@grammyjs/transformer-throttler", () => ({
  apiThrottler,
  BottleneckStrategy: { OVERFLOW: OVERFLOW_STRATEGY },
}));
mock.module("@grammyjs/files", () => ({ hydrateFiles }));
mock.module("../../packages/infra/telegram/outboundGate", () => ({
  initTelegramOutbound,
  telegramOutboundGate,
}));
mock.module("../../packages/config/telegram", () => ({ BOT_TOKEN: "token:secret" }));
mock.module("../../packages/infra/logger", () => ({
  logger: {
    log: mock((..._args: unknown[]): void => {}),
    info: mock((..._args: unknown[]): void => {}),
    warn: mock((..._args: unknown[]): void => {}),
    error: loggerError,
  },
}));

const client = await import("../../packages/infra/telegram/client");
const botConstructionsAfterFacadeImport: number = botConstructions;
const mainClient = await import("../../packages/infra/telegram/mainClient");

describe("Telegram 客户端初始化", () => {
  test("共享门面导入不读取 token 或构造 grammY Bot", () => {
    expect(botConstructionsAfterFacadeImport).toBe(0);
    expect(botConstructions).toBe(1);
  });

  test("唯一客户端安装文件增强、消息节流和分类型 429 闸门，重复初始化幂等", () => {
    mainClient.initTelegramClients();
    mainClient.initTelegramClients();

    expect(botUse).toHaveBeenCalledTimes(3);
    expect(botUse).toHaveBeenNthCalledWith(1, { kind: "files", token: "token:secret" });
    expect(botUse).toHaveBeenNthCalledWith(2, expect.any(Function));
    expect(botUse).toHaveBeenNthCalledWith(3, { kind: "outbound-gate" });
    expect(apiThrottler).toHaveBeenCalledTimes(1);
    expect(apiThrottler).toHaveBeenCalledWith({
      global: expect.objectContaining({
        reservoir: 30,
        reservoirRefreshAmount: 30,
        reservoirRefreshInterval: 1_000,
        highWater: 8_192,
        strategy: OVERFLOW_STRATEGY,
      }),
      group: {
        maxConcurrent: 1,
        minTime: 1_000,
        highWater: 128,
        strategy: OVERFLOW_STRATEGY,
      },
      out: expect.objectContaining({
        maxConcurrent: 1,
        minTime: 1_000,
        highWater: 256,
        strategy: OVERFLOW_STRATEGY,
      }),
    });
    expect(telegramOutboundGate).toHaveBeenCalledTimes(1);
    expect(initTelegramOutbound).toHaveBeenCalledTimes(1);
    expect(hydrateFiles).toHaveBeenCalledTimes(1);
    expect(hydrateFiles).toHaveBeenCalledWith("token:secret");
    expect((mainClient.bot as unknown as FakeBot).token).toBe("token:secret");
    expect(client.currentTelegramApi()).not.toBe(mainClient.bot.api);
    expect(client.joinVerificationApi).not.toBe(mainClient.bot.api);
  });

  test("主线程适配器在最终网络边界才构造 InputFile", async () => {
    mainClient.initTelegramClients();
    mainSendPhoto.mockClear();
    const bytes: Uint8Array = new Uint8Array([1, 2, 3]);

    await client.telegramApi.sendPhoto(
      -1001,
      { bytes, fileName: "generated.png" },
      { caption: "generated" }
    );

    expect(mainSendPhoto).toHaveBeenCalledWith(
      -1001,
      expect.objectContaining({ bytes, fileName: "generated.png" }),
      { caption: "generated" },
      undefined
    );
  });

  test("GrammyError 展开状态码，普通异常保留原对象", () => {
    const apiError = new FakeGrammyError("failed", { error_code: 429, description: "Too Many Requests" });
    client.logApiError("send message", apiError);
    expect(loggerError).toHaveBeenLastCalledWith("Failed to send message: 429 Too Many Requests");

    const generic = new Error("socket closed");
    client.logApiError("send message", generic);
    expect(loggerError).toHaveBeenLastCalledWith("Error trying to send message:", generic);
  });
});
