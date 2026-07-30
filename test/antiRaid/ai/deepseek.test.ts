import { beforeEach, describe, expect, mock, test } from "bun:test";

const errorLogs: string[] = [];
const constructions: unknown[] = [];
const create = mock(async (..._args: unknown[]): Promise<unknown> => ({
  choices: [{ message: { content: "{\"ok\": true}" } }],
}));

class FakeAPIError extends Error {
  status: number = 429;
}

mock.module("../../../packages/infra/logger", () => ({
  logger: {
    log(): void {},
    info(): void {},
    warn(): void {},
    error(message: unknown): void { errorLogs.push(String(message)); },
  },
}));
mock.module("openai", () => {
  class FakeOpenAI {
    chat: { completions: { create: typeof create } } = { completions: { create } };
    constructor(options: unknown) { constructions.push(options); }
    static APIError: typeof FakeAPIError = FakeAPIError;
  }
  return { default: FakeOpenAI, APIError: FakeAPIError };
});

const { requestDeepSeekJson } = await import("../../../packages/antiRaid/ai/deepseek");
const {
  DEEPSEEK_API_BASE_URL,
  DEEPSEEK_EMPTY_BODY_MAX_ATTEMPTS,
  DEEPSEEK_REQUEST_MAX_RETRIES,
  DEEPSEEK_REQUEST_TIMEOUT_MS,
} = await import("../../../packages/consts/deepseek");

function request(overrides: Record<string, unknown> = {}): never {
  return {
    model: "deepseek-v4-flash",
    systemPrompt: "只输出 JSON",
    userContent: "1. 在吗",
    temperature: 0,
    maxOutputTokens: 256,
    errorLabel: "Test request",
    ...overrides,
  } as never;
}

beforeEach(() => {
  errorLogs.length = 0;
  constructions.length = 0;
  create.mockClear();
  create.mockImplementation(async (): Promise<unknown> => ({
    choices: [{ message: { content: "{\"ok\": true}" } }],
  }));
});

describe("DeepSeek 请求入口", () => {
  test("按传入参数发一次 JSON 模式请求，客户端只构造一次", async () => {
    await expect(requestDeepSeekJson(request())).resolves.toBe("{\"ok\": true}");
    await requestDeepSeekJson(request());
    // 线程内单例：客户端构造远贵于一次请求，Worker 重建后才会重新构造。
    expect(constructions).toHaveLength(1);
    expect(constructions[0]).toMatchObject({
      baseURL: DEEPSEEK_API_BASE_URL,
      timeout: DEEPSEEK_REQUEST_TIMEOUT_MS,
      maxRetries: DEEPSEEK_REQUEST_MAX_RETRIES,
    });

    const body = create.mock.calls[0]?.[0] as {
      model: string;
      temperature: number;
      max_tokens: number;
      response_format: { type: string };
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(256);
    expect(body.response_format).toEqual({ type: "json_object" });
    // 提示词与待判定内容分属两个 role：正文永远只作为数据出现。
    expect(body.messages).toEqual([
      { role: "system", content: "只输出 JSON" },
      { role: "user", content: "1. 在吗" },
    ]);
  });

  test("正文为空时重试一次；重试拿到正文就照常返回", async () => {
    // 推理模型的空转是抖动而不是判断结果：交回空串会被调用方读成「没有结论」，
    // 与「模型认为不是广告」不可区分，成为一次没有日志痕迹的漏判。
    create.mockImplementationOnce(async (): Promise<unknown> => ({
      choices: [{ finish_reason: "stop", message: { content: "" } }],
    }));
    await expect(requestDeepSeekJson(request())).resolves.toBe("{\"ok\": true}");
    expect(create).toHaveBeenCalledTimes(2);
    expect(errorLogs).toHaveLength(0);
  });

  test("反复空转到上限才记日志并返回 null", async () => {
    create.mockImplementation(async (): Promise<unknown> => ({
      choices: [{ finish_reason: "stop", message: { content: "   " } }],
    }));
    await expect(requestDeepSeekJson(request())).resolves.toBeNull();
    expect(create).toHaveBeenCalledTimes(DEEPSEEK_EMPTY_BODY_MAX_ATTEMPTS);
    expect(errorLogs[0]).toContain(`no usable body in ${DEEPSEEK_EMPTY_BODY_MAX_ATTEMPTS} attempt(s)`);

    // 整个 choices 缺失同样算空转，不是「拿到了一个空答案」。
    errorLogs.length = 0;
    create.mockImplementation(async (): Promise<unknown> => ({ choices: [] }));
    await expect(requestDeepSeekJson(request())).resolves.toBeNull();
    expect(errorLogs[0]).toContain("no usable body");
  });

  test("额度被推理吃光时同样重来，最终失败点名截断与两个额度数字", async () => {
    create.mockImplementation(async (): Promise<unknown> => ({
      choices: [{ finish_reason: "length", message: { content: "{\"ad\": tr" } }],
      usage: { completion_tokens_details: { reasoning_tokens: 64 } },
    }));
    await expect(requestDeepSeekJson(request())).resolves.toBeNull();
    // 截断的正文多半是半个 JSON，交回去只会让调用方多做一次注定失败的解析。
    expect(errorLogs[0]).toContain("truncated=true");
    expect(errorLogs[0]).toContain("hasPartialText=true");
    expect(errorLogs[0]).toContain("reasoning_tokens=64");
    expect(errorLogs[0]).toContain("max_tokens=256");
  });

  test("请求本身失败时不再自旋：SDK 已按 maxRetries 重试过", async () => {
    create.mockImplementation((): never => { throw new FakeAPIError("rate limited"); });
    await expect(requestDeepSeekJson(request())).resolves.toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("API 报错与未知异常都按 errorLabel 记日志并返回 null", async () => {
    create.mockImplementationOnce((): never => { throw new FakeAPIError("rate limited"); });
    await expect(requestDeepSeekJson(request())).resolves.toBeNull();
    expect(errorLogs[0]).toBe("Test request failed: 429 rate limited");

    create.mockImplementationOnce((): never => { throw new Error("socket hang up"); });
    await expect(requestDeepSeekJson(request())).resolves.toBeNull();
    expect(errorLogs[1]).toBe("Error calling Test request:");
  });
});
