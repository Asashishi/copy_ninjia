import { describe, expect, spyOn, test } from "bun:test";
import type { DiskIOMessage, DiskIOReply, LogEnvelope } from "../../packages/types";

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
      expect(worker.messages).toEqual([{ type: "load" }]);
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
        blockedUsers: new Map(),
        pendingBlockedRemovals: new Map(),
      } satisfies DiskIOReply } as MessageEvent<DiskIOReply>);
      await loaded;
      worker.messages.length = 0;

      logger.error("after-lock", new Error("persist me"));
      expect(worker.messages).toHaveLength(1);
      const message: DiskIOMessage = worker.messages[0]!;
      expect(message.type).toBe("log");
      const log = message as LogEnvelope;
      expect(log.level).toBe("error");
      expect(log.args[0]).toBe("after-lock");
      expect(log.args[1]).toMatchObject({ name: "Error", message: "persist me" });
    } finally {
      consoleInfo.mockRestore();
      consoleError.mockRestore();
      globalThis.Worker = originalWorker;
    }
  });

  test("字符串参数与 Error 可枚举字段里的敏感值都被脱敏后才进控制台与落盘", () => {
    const token: string = process.env.TELEGRAM_BOT_TOKEN!;
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
    }
  });

  test("env 首尾空白不会让请求实际使用的规范化密钥逃过脱敏", () => {
    const originalSecrets: Readonly<Record<string, string | undefined>> = {
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
      AI_CHAT_GEMINI_API_KEY: process.env.AI_CHAT_GEMINI_API_KEY,
      AD_DETECT_DEEPSEEK_API_KEY: process.env.AD_DETECT_DEEPSEEK_API_KEY,
    };
    const normalizedSecrets: readonly string[] = [
      "normalized-telegram-token",
      "normalized-gemini-key",
      "normalized-deepseek-key",
    ];
    process.env.TELEGRAM_BOT_TOKEN = `  ${normalizedSecrets[0]}\r`;
    process.env.AI_CHAT_GEMINI_API_KEY = `\t${normalizedSecrets[1]}  `;
    process.env.AD_DETECT_DEEPSEEK_API_KEY = `${normalizedSecrets[2]}\n`;
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
      for (const [name, value] of Object.entries(originalSecrets)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
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
    const originalSecret: string | undefined = process.env.AD_DETECT_DEEPSEEK_API_KEY;
    // optionalEnv 只要求 trim 后非空，`"` 是一个能通过校验的配错值：它会把整份
    // 序列化文本里的每个引号都换成 [REDACTED]，产物不再是合法 JSON。
    process.env.AD_DETECT_DEEPSEEK_API_KEY = "\"";
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
      if (originalSecret === undefined) delete process.env.AD_DETECT_DEEPSEEK_API_KEY;
      else process.env.AD_DETECT_DEEPSEEK_API_KEY = originalSecret;
    }
  });
});
