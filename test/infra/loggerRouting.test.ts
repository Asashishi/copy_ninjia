import { describe, expect, spyOn, test } from "bun:test";
import { REDACTED_SECRET } from "../../packages/libs/redaction";
import type {
  DiskDiagnosticBatchRequest,
  DiskIOMessage,
  DiskIOReply,
  LogEnvelope,
} from "../../packages/types";
import type {
  AdDetectAgentConfig,
  AgentDeploymentConfig,
  TelegramConfig,
} from "../../packages/types/config";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly messages: DiskIOMessage[] = [];

  constructor(readonly url: string) {
    FakeWorker.instances.push(this);
  }

  unref(): void {}

  postMessage(message: DiskIOMessage): void {
    this.messages.push(message);
  }
}

const diskIO = await import("../../packages/infra/diskIO");
const { logger } = await import("../../packages/infra/logger");
const {
  adoptAdDetectAgentConfig,
  adoptAgentDeploymentConfig,
} = await import("../../packages/config/agent");
const {
  adDetectAgentConfigCache,
  agentDeploymentConfigCache,
  telegramConfigCache,
} = await import("../../packages/cache/perThread/config");

describe("logger persistence routing boundary", () => {
  test("初始化前只写控制台，完整恢复成功后 error 才转投唯一落盘 Worker", async () => {
    const originalWorker: typeof Worker = globalThis.Worker;
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const consoleInfo = spyOn(console, "info").mockImplementation(() => {});
    try {
      logger.error("before-lock");
      expect(consoleError).toHaveBeenCalledWith("before-lock");
      expect(FakeWorker.instances).toHaveLength(0);

      diskIO.initDiskIO();
      const worker: FakeWorker = FakeWorker.instances[0]!;
      logger.info("console-only");
      expect(consoleInfo).toHaveBeenCalledWith("console-only");
      expect(worker.messages).toHaveLength(0);

      const loaded = diskIO.loadPersistedData(1_000);
      expect(worker.messages).toEqual([expect.objectContaining({ type: "load" })]);
      worker.onmessage!({ data: {
        type: "loaded",
        aiMemories: new Map(),
        stickerCatalogs: new Map(),
        luckDay: null,
        luckReceiptSecret: {
          version: 1,
          day: "2026-07-20",
          key: Buffer.alloc(32, 1).toString("base64url"),
        },
        verifications: new Map(),
        pendingBlockedRemovals: new Map(),
        blocklistEntryCount: 0,
        whitelistEntryCount: 0,
        chatStates: new Map(),
        chatQa: new Map(),
      } satisfies DiskIOReply } as MessageEvent<DiskIOReply>);
      await loaded;
      worker.messages.length = 0;

      logger.error("after-lock", new Error("persist me"));
      expect(worker.messages).toHaveLength(1);
      const message: DiskIOMessage = worker.messages[0]!;
      expect(message.type).toBe("diagnosticBatch");
      const batch: DiskDiagnosticBatchRequest = message as DiskDiagnosticBatchRequest;
      const log: LogEnvelope = batch.messages[0] as LogEnvelope;
      expect(log.level).toBe("error");
      expect(log.args[0]).toBe("after-lock");
      expect(log.args[1]).toMatchObject({ name: "Error", message: "persist me" });
      worker.onmessage!({
        data: { type: "diagnosticBatchAccepted", batchId: batch.batchId },
      } as MessageEvent<DiskIOReply>);
    } finally {
      consoleInfo.mockRestore();
      consoleError.mockRestore();
      globalThis.Worker = originalWorker;
    }
  });

  test("字符串参数与 Error 可枚举字段里的敏感值都被脱敏后才进控制台与落盘", () => {
    const originalTelegram: TelegramConfig | null = telegramConfigCache.current;
    const token: string = "logger-telegram-token";
    telegramConfigCache.current = { botToken: token, superAdminUserId: 1 };
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      // 字符串走的是不经 JSON 往返的快路径；对象/Error 仍走序列化后整份脱敏。
      logger.error(`download failed: https://api.telegram.org/file/bot${token}/photo.jpg`);
      const stringArg: unknown = consoleError.mock.calls.at(-1)![0];
      expect(stringArg).toBe("download failed: https://api.telegram.org/file/bot[REDACTED]/photo.jpg");
      expect(String(stringArg)).not.toContain(token);

      const failure = Object.assign(new Error("fetch failed"), {
        path: `https://api.telegram.org/file/bot${token}/photo.jpg`,
      });
      logger.error("boom", failure);
      const errorArg = consoleError.mock.calls.at(-1)![1] as { path: string; message: string };
      expect(errorArg.message).toBe("fetch failed");
      expect(errorArg.path).toBe("https://api.telegram.org/file/bot[REDACTED]/photo.jpg");
      expect(JSON.stringify(errorArg)).not.toContain(token);
    } finally {
      consoleError.mockRestore();
      telegramConfigCache.current = originalTelegram;
    }
  });

  /**
   * 脱敏值列表按三个 holder 的对象身份记忆化（见 cache/perThread/logger.ts 的
   * loggerSecretsMemo）。这条用例守的是那次记忆化唯一可能造成的事故：三个 holder
   * 都是惰性填充的，取得实例锁之前就会有日志经过这里，若把那时算出的空结果按
   * 「已经算过一次」缓存下来，配置读完之后每一条日志都不再脱敏——凭据从此原样
   * 进 journal 与 logs/，而且没有任何报错。
   */
  test("配置在第一条日志之后才填上时，后续日志照常脱敏（记忆化不得把空结果钉死）", () => {
    const originalTelegram: TelegramConfig | null = telegramConfigCache.current;
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      telegramConfigCache.current = null;
      logger.error("no-config-yet");
      expect(consoleError.mock.calls.at(-1)![0]).toBe("no-config-yet");

      const token: string = "late-arriving-telegram-token";
      telegramConfigCache.current = { botToken: token, superAdminUserId: 1 };
      logger.error(`now with token ${token}`);
      const stringArg: unknown = consoleError.mock.calls.at(-1)![0];
      expect(stringArg).toBe(`now with token ${REDACTED_SECRET}`);
      expect(String(stringArg)).not.toContain(token);

      // 换成另一份配置同样要立刻生效（测试替身与启动总闸都是整体替换 holder）。
      const rotated: string = "rotated-telegram-token";
      telegramConfigCache.current = { botToken: rotated, superAdminUserId: 1 };
      logger.error(`rotated ${rotated} but old ${token}`);
      const afterRotate: string = String(consoleError.mock.calls.at(-1)![0]);
      expect(afterRotate).not.toContain(rotated);
      // 旧 token 已经不在配置里，不该再被当成敏感值抹掉。
      expect(afterRotate).toContain(token);
    } finally {
      consoleError.mockRestore();
      telegramConfigCache.current = originalTelegram;
    }
  });

  test("telegram 与 agent 配置中实际使用的密钥都会脱敏", () => {
    const originalTelegram: TelegramConfig | null = telegramConfigCache.current;
    const originalAgent: AgentDeploymentConfig | null = agentDeploymentConfigCache.current;
    const originalAdDetect: AdDetectAgentConfig | null = adDetectAgentConfigCache.current;
    const normalizedSecrets: readonly [string, string, string] = [
      "normalized-telegram-token",
      "normalized-gemini-key",
      "normalized-deepseek-key",
    ];
    telegramConfigCache.current = {
      botToken: normalizedSecrets[0],
      superAdminUserId: 1,
    };
    agentDeploymentConfigCache.current = {
      text: { provider: "google", apiKey: normalizedSecrets[1], baseUrl: undefined, model: "text" },
      summary: { provider: "openai", apiKey: "summary-key", baseUrl: undefined, model: "summary" },
      media: { provider: "google", apiKey: "media-key", baseUrl: undefined, model: "media" },
    };
    adDetectAgentConfigCache.current = {
      provider: "openai",
      apiKey: normalizedSecrets[2],
      baseUrl: "https://api.deepseek.com",
      model: "ad",
    };
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      logger.error(
        `request failed: ${normalizedSecrets.join(" / ")}`,
        Object.assign(new Error("fetch failed"), {
          path: `https://api.telegram.org/file/bot${normalizedSecrets[0]}/photo.jpg`,
          details: { apiKey: normalizedSecrets[1], cause: normalizedSecrets[2] },
        })
      );

      const stringArg: unknown = consoleError.mock.calls.at(-1)![0];
      const errorArg: unknown = consoleError.mock.calls.at(-1)![1];
      expect(stringArg).toBe("request failed: [REDACTED] / [REDACTED] / [REDACTED]");
      expect(errorArg).toMatchObject({
        path: "https://api.telegram.org/file/bot[REDACTED]/photo.jpg",
        details: { apiKey: "[REDACTED]", cause: "[REDACTED]" },
      });
      const serialized: string = JSON.stringify([stringArg, errorArg]);
      for (const secret of normalizedSecrets) expect(serialized).not.toContain(secret);
    } finally {
      consoleError.mockRestore();
      telegramConfigCache.current = originalTelegram;
      agentDeploymentConfigCache.current = originalAgent;
      adDetectAgentConfigCache.current = originalAdDetect;
    }
  });

  test("Worker 侧 adopt 进来的快照同样进脱敏名单", () => {
    // 两条业务线程不读盘，凭据只经初始化消息 adopt 进本 isolate 的 holder
    // （见 config/agent.ts）。脱敏名单读的就是这两个 holder，因此这条路必须与
    // 主线程解析那条等价——否则 Worker 里的 SDK 报错会把 api_key 原样带进
    // journal 与 logs/。
    const originalAgent: AgentDeploymentConfig | null = agentDeploymentConfigCache.current;
    const originalAdDetect: AdDetectAgentConfig | null = adDetectAgentConfigCache.current;
    const workerSecrets: readonly string[] = [
      "adopted-text-key",
      "adopted-summary-key",
      "adopted-media-key",
      "adopted-image-key",
      "adopted-song-key",
      "adopted-ad-key",
    ];
    adoptAgentDeploymentConfig({
      text: { provider: "google", apiKey: "adopted-text-key", baseUrl: undefined, model: "text" },
      summary: { provider: "openai", apiKey: "adopted-summary-key", baseUrl: undefined, model: "summary" },
      media: { provider: "google", apiKey: "adopted-media-key", baseUrl: undefined, model: "media" },
      image: { provider: "google", apiKey: "adopted-image-key", baseUrl: undefined, model: "image", imageProtocol: undefined },
      song: { provider: "google", apiKey: "adopted-song-key", baseUrl: undefined, model: "song" },
    });
    adoptAdDetectAgentConfig({
      provider: "openai",
      apiKey: "adopted-ad-key",
      baseUrl: "https://api.deepseek.com",
      model: "ad",
    });
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      logger.error(
        `worker request failed: ${workerSecrets.join(" / ")}`,
        Object.assign(new Error("upstream rejected"), {
          headers: { authorization: `Bearer ${workerSecrets[0]}` },
          query: `key=${workerSecrets[5]}`,
        })
      );
      const serialized: string = JSON.stringify(consoleError.mock.calls.at(-1));
      for (const secret of workerSecrets) expect(serialized).not.toContain(secret);
    } finally {
      consoleError.mockRestore();
      agentDeploymentConfigCache.current = originalAgent;
      adDetectAgentConfigCache.current = originalAdDetect;
    }
  });

  test("SDK 错误对象里的凭据响应头按字段脱敏，非敏感诊断保持可读", () => {
    const cloudflareCookie: string = "__cf_bm=cloudflare-sensitive-cookie; HttpOnly; Secure";
    const bearer: string = "Bearer upstream-sensitive-token";
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const failure = Object.assign(new Error("xAI request failed"), {
        headers: {
          "set-cookie": [cloudflareCookie],
          Authorization: bearer,
          "x-request-id": "request-visible-123",
        },
        rawHeaders: [
          ["Set-Cookie", cloudflareCookie],
          ["x-ratelimit-remaining", "42"],
        ],
        usage: { output_tokens: 17 },
      });

      logger.error("image request failed", failure);

      const serialized: unknown = consoleError.mock.calls.at(-1)![1];
      expect(serialized).toMatchObject({
        message: "xAI request failed",
        headers: {
          "set-cookie": REDACTED_SECRET,
          Authorization: REDACTED_SECRET,
          "x-request-id": "request-visible-123",
        },
        rawHeaders: [
          ["Set-Cookie", REDACTED_SECRET],
          ["x-ratelimit-remaining", "42"],
        ],
        usage: { output_tokens: 17 },
      });
      const text: string = JSON.stringify(serialized);
      expect(text).not.toContain(cloudflareCookie);
      expect(text).not.toContain(bearer);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("字符串化响应头与扁平 rawHeaders 同样脱敏，并保留非凭据诊断", () => {
    const cloudflareCookie: string =
      "__cf_bm=string-or-flat-sensitive-cookie; Expires=Thu, 06 Aug 2099 16:57:18 GMT; HttpOnly";
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      logger.error(
        `upstream failed: {"set-cookie":["${cloudflareCookie}"],` +
        `"x-request-id":"request-visible-456","x-ratelimit-remaining":"40","output_tokens":18}`
      );
      const textArg: string = String(consoleError.mock.calls.at(-1)![0]);
      expect(textArg).not.toContain(cloudflareCookie);
      expect(textArg).toContain(REDACTED_SECRET);
      expect(textArg).toContain("request-visible-456");
      expect(textArg).toContain("\"x-ratelimit-remaining\":\"40\"");
      expect(textArg).toContain("\"output_tokens\":18");

      const failure = Object.assign(
        new Error(
          `upstream failed: {"set-cookie":["${cloudflareCookie}"],` +
          `"x-request-id":"request-visible-789"}`
        ),
        {
          rawHeaders: [
            "x-request-id",
            "request-visible-789",
            "Set-Cookie",
            cloudflareCookie,
            "x-ratelimit-remaining",
            "41",
          ],
          usage: { output_tokens: 19 },
        }
      );
      logger.error("image request failed", failure);

      const serialized: unknown = consoleError.mock.calls.at(-1)![1];
      const message: string = (serialized as { message: string }).message;
      expect(message.includes("request-visible-789")).toBeTrue();
      expect(serialized).toMatchObject({
        message: expect.stringContaining(REDACTED_SECRET),
        rawHeaders: [
          "x-request-id",
          "request-visible-789",
          "Set-Cookie",
          REDACTED_SECRET,
          "x-ratelimit-remaining",
          "41",
        ],
        usage: { output_tokens: 19 },
      });
      const serializedText: string = JSON.stringify(serialized);
      expect(serializedText).not.toContain(cloudflareCookie);
      expect(serializedText).toContain("request-visible-789");
    } finally {
      consoleError.mockRestore();
    }
  });

  test("Error 自带 __proto__ 自有属性时照常落进诊断字段，不命中原型访问器", () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      // 依赖抛出来的 Error 带上这个键并不稀奇（grammY/genai/sharp/gRPC 包装的
      // payload 都可能）。累加对象若是普通 `{}`，`own[key] = ...` 命中的是
      // Object.prototype 继承来的访问器：值是对象就静默换掉记录的原型，不是对象
      // 就整句赋值失效——两种结局都让这个字段从 logs/ 的错误记录里消失，而它
      // 往往正是唯一能解释本次故障的诊断。
      const error: Error = new Error("dependency blew up");
      Object.defineProperty(error, "__proto__", {
        value: { hint: "from dependency" },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      logger.error("boom", error);

      const serialized: unknown = consoleError.mock.calls.at(-1)![1];
      expect(serialized).toMatchObject({
        message: "dependency blew up",
        ["__proto__"]: { hint: "from dependency" },
      });
      // 原型没有被换掉：记录仍是普通对象。
      expect(Object.getPrototypeOf(serialized as object)).toBe(Object.prototype);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("密钥恰好是 JSON 结构字符时，脱敏后解析不了也不能让 logger 自己抛出去", () => {
    const originalConfig: AdDetectAgentConfig | null = adDetectAgentConfigCache.current;
    // `"` 是一个能通过非空配置校验的配错值：它会把整份
    // 序列化文本里的每个引号都换成 [REDACTED]，产物不再是合法 JSON。
    adDetectAgentConfigCache.current = {
      provider: "openai",
      apiKey: "\"",
      baseUrl: "https://api.deepseek.com",
      model: "ad",
    };
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      // 这里若从 logger 内部抛出 SyntaxError，catch 块里的这句 logger.error 就会
      // 顶掉原始错误：真实故障一条都不落盘，连 uncaughtException 处理器都会在
      // 汇报退出原因时再炸一次。
      expect((): void => logger.error("boom", new Error("fetch failed"))).not.toThrow();
      const fallback: unknown = consoleError.mock.calls.at(-1)![1];
      // 解析不了就退化成脱敏后的文本，敏感值仍然不得出现。
      expect(typeof fallback).toBe("string");
      expect(String(fallback)).toContain("fetch failed");
      expect(String(fallback)).toContain("[REDACTED]");
    } finally {
      consoleError.mockRestore();
      adDetectAgentConfigCache.current = originalConfig;
    }
  });

  test("异常对象的 getter、转换方法与 Proxy trap 只能降级内容，不能让 logger 抛错", () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const hostileObject: object = {
        toJSON(): never {
          throw new Error("toJSON failed");
        },
        toString(): never {
          throw new Error("toString failed");
        },
      };
      expect((): void => logger.error(hostileObject)).not.toThrow();
      expect(consoleError.mock.calls.at(-1)![0]).toBe("[unserializable value]");

      const hostileError: Error = new Error("original failure");
      Object.defineProperty(hostileError, "name", {
        enumerable: false,
        get(): never {
          throw new Error("name getter failed");
        },
      });
      Object.defineProperty(hostileError, "response", {
        enumerable: true,
        get(): never {
          throw new Error("response getter failed");
        },
      });
      expect((): void => logger.error(hostileError)).not.toThrow();
      expect(consoleError.mock.calls.at(-1)![0]).toMatchObject({
        name: "Error",
        message: "original failure",
        response: "[unserializable value]",
      });

      const proxiedError: Error = new Proxy(new Error("proxied failure"), {
        ownKeys(): never {
          throw new Error("ownKeys failed");
        },
      });
      expect((): void => logger.error(proxiedError)).not.toThrow();
      expect(consoleError.mock.calls.at(-1)![0]).toMatchObject({
        name: "Error",
        message: "proxied failure",
      });

      const revoked: { proxy: object; revoke: () => void } = Proxy.revocable({}, {});
      revoked.revoke();
      expect((): void => logger.error(revoked.proxy)).not.toThrow();
      expect(consoleError.mock.calls.at(-1)![0]).toBe("[unserializable value]");
    } finally {
      consoleError.mockRestore();
    }
  });
});
