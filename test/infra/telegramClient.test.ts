import { describe, expect, mock, test } from "bun:test";

const botUse = mock((..._args: unknown[]): void => {});
const joinUse = mock((..._args: unknown[]): void => {});
const loggerError = mock((..._args: unknown[]): void => {});
const apiThrottler = mock(() => ({ kind: "throttler" }));
const autoRetry = mock((options: unknown) => ({ kind: "retry", options }));
const hydrateFiles = mock((token: string) => ({ kind: "files", token }));

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
  readonly api = { config: { use: botUse } };
  constructor(readonly token: string) {}
}

class FakeApi {
  readonly config = { use: joinUse };
  constructor(readonly token: string) {}
}

mock.module("grammy", () => ({ Api: FakeApi, Bot: FakeBot, GrammyError: FakeGrammyError }));
mock.module("@grammyjs/transformer-throttler", () => ({ apiThrottler }));
mock.module("@grammyjs/auto-retry", () => ({ autoRetry }));
mock.module("@grammyjs/files", () => ({ hydrateFiles }));
mock.module("../../packages/infra/config", () => ({ BOT_TOKEN: "token:secret" }));
mock.module("../../packages/infra/logger", () => ({
  logger: {
    log: mock((..._args: unknown[]): void => {}),
    info: mock((..._args: unknown[]): void => {}),
    warn: mock((..._args: unknown[]): void => {}),
    error: loggerError,
  },
}));

const client = await import("../../packages/infra/telegram/client");

describe("Telegram 客户端初始化", () => {
  test("默认客户端安装文件增强，两客户端各安装节流与重试，重复初始化幂等", () => {
    client.initTelegramClients();
    client.initTelegramClients();

    expect(botUse).toHaveBeenCalledTimes(3);
    expect(joinUse).toHaveBeenCalledTimes(2);
    expect(apiThrottler).toHaveBeenCalledTimes(2);
    expect(autoRetry).toHaveBeenCalledTimes(2);
    expect(hydrateFiles).toHaveBeenCalledTimes(1);
    expect(hydrateFiles).toHaveBeenCalledWith("token:secret");
    expect((client.bot as unknown as FakeBot).token).toBe("token:secret");
    expect((client.joinVerificationApi as unknown as FakeApi).token).toBe("token:secret");
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
