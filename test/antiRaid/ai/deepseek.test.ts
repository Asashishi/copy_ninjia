import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";

const errorLogs: string[] = [];
const constructions: unknown[] = [];
const create = mock(async (..._args: unknown[]): Promise<unknown> => ({
  choices: [{ message: { content: "{\"ok\": true}" } }],
}));

/** 与 openai SDK 的 APIError 一致：message 以 HTTP 状态码开头。 */
class FakeAPIError extends Error {
  readonly status: number = 429;
  constructor(message: string) {
    super(`429 ${message}`);
  }
}

mock.module("../../../packages/infra/logger", () => ({
  logger: loggerStub({ error(message: unknown): void { errorLogs.push(String(message)); } }),
}));
mock.module("../../../packages/config/agent", () => ({
  getAdDetectAgentConfig: () => ({
    provider: "openai",
    apiKey: "deepseek-key",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
  }),
}));
mock.module("openai", () => {
  class FakeOpenAI {
    chat: { completions: { create: typeof create } } = { completions: { create } };
    constructor(options: unknown) { constructions.push(options); }
    static APIError: typeof FakeAPIError = FakeAPIError;
  }
  return { default: FakeOpenAI, APIError: FakeAPIError };
});

const { requestOpenAiAdDetectJson } = await import("../../../packages/antiRaid/ai/openai");
const { adDetectOpenAiClientHolder } = await import("../../../packages/cache/workers/antiRaid/openai");
const {
  AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS,
  AD_DETECT_OPENAI_REQUEST_MAX_RETRIES,
  AD_DETECT_OPENAI_REQUEST_TIMEOUT_MS,
} = await import("../../../packages/consts/antiRaid/adDetect");

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
  adDetectOpenAiClientHolder.current = null;
  errorLogs.length = 0;
  constructions.length = 0;
  create.mockClear();
  create.mockImplementation(async (): Promise<unknown> => ({
    choices: [{ message: { content: "{\"ok\": true}" } }],
  }));
});

describe("OpenAI 兼容广告检测请求入口", () => {
  test("按传入参数发一次 JSON 模式请求，客户端只构造一次", async () => {
    await expect(requestOpenAiAdDetectJson(request())).resolves.toBe("{\"ok\": true}");
    await requestOpenAiAdDetectJson(request());
    // 两次请求复用同一客户端实例，只在首次请求时构造。
    expect(constructions).toHaveLength(1);
    expect(constructions[0]).toMatchObject({
      baseURL: "https://api.deepseek.com",
      timeout: AD_DETECT_OPENAI_REQUEST_TIMEOUT_MS,
      maxRetries: AD_DETECT_OPENAI_REQUEST_MAX_RETRIES,
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
    // 系统提示词与待判定正文分别落在 system/user 两条消息上。
    expect(body.messages).toEqual([
      { role: "system", content: "只输出 JSON" },
      { role: "user", content: "1. 在吗" },
    ]);
  });

  test("正文为空时重试一次；重试拿到正文就照常返回", async () => {
    // 首次返回空正文，重试的实现走 beforeEach 里设置的默认 mock（返回可用正文）。
    create.mockImplementationOnce(async (): Promise<unknown> => ({
      choices: [{ finish_reason: "stop", message: { content: "" } }],
    }));
    await expect(requestOpenAiAdDetectJson(request())).resolves.toBe("{\"ok\": true}");
    expect(create).toHaveBeenCalledTimes(2);
    expect(errorLogs).toHaveLength(0);
  });

  test("反复空转到上限才记日志并返回 null", async () => {
    create.mockImplementation(async (): Promise<unknown> => ({
      choices: [{ finish_reason: "stop", message: { content: "   " } }],
    }));
    await expect(requestOpenAiAdDetectJson(request())).resolves.toBeNull();
    expect(create).toHaveBeenCalledTimes(AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS);
    expect(errorLogs[0]).toContain(`no usable body in ${AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS} attempt(s)`);

    // choices 数组为空同样按空正文计入重试。
    errorLogs.length = 0;
    create.mockImplementation(async (): Promise<unknown> => ({ choices: [] }));
    await expect(requestOpenAiAdDetectJson(request())).resolves.toBeNull();
    expect(errorLogs[0]).toContain("no usable body");
  });

  test("额度被推理吃光时同样重来，最终失败点名截断与两个额度数字", async () => {
    create.mockImplementation(async (): Promise<unknown> => ({
      choices: [{ finish_reason: "length", message: { content: "{\"ad\": tr" } }],
      usage: { completion_tokens_details: { reasoning_tokens: 64 } },
    }));
    await expect(requestOpenAiAdDetectJson(request())).resolves.toBeNull();
    // 因 reasoning 占满额度被截断时返回 null，错误日志带 truncated/hasPartialText/reasoning_tokens/max_tokens 四个字段。
    expect(errorLogs[0]).toContain("truncated=true");
    expect(errorLogs[0]).toContain("hasPartialText=true");
    expect(errorLogs[0]).toContain("reasoning_tokens=64");
    expect(errorLogs[0]).toContain("max_tokens=256");
  });

  test("请求本身失败时不再自旋：SDK 已按 maxRetries 重试过", async () => {
    create.mockImplementation((): never => { throw new FakeAPIError("rate limited"); });
    await expect(requestOpenAiAdDetectJson(request())).resolves.toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("API 报错与未知异常都按 errorLabel 记日志并返回 null", async () => {
    create.mockImplementationOnce((): never => { throw new FakeAPIError("rate limited"); });
    await expect(requestOpenAiAdDetectJson(request())).resolves.toBeNull();
    expect(errorLogs[0]).toBe("Test request failed: 429 rate limited");

    create.mockImplementationOnce((): never => { throw new Error("socket hang up"); });
    await expect(requestOpenAiAdDetectJson(request())).resolves.toBeNull();
    expect(errorLogs[1]).toBe("Error calling Test request:");
  });
});
