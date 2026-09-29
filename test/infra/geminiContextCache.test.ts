/**
 * Gemini 显式缓存共用核心的本地登记与后台生命周期：启动扫描接管、按槽创建与换内容、
 * 续期与续期失败冷却、释放、创建失败冷却与 400 拒绝、槽数淘汰、换表与停机取消。
 * 用例按真实 scope 参数化，SDK 的 caches 接口整体替换成可控的假实现。
 */

import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { ApiError } from "@google/genai";
import type { CachedContent, GoogleGenAI, Tool } from "@google/genai";
import { loggerStub } from "../helpers/loggerMock";
import { waitUntil } from "../helpers/waitUntil";
import type {
  GeminiContextCacheContent,
  GeminiContextCacheRegistry,
  GeminiContextCacheScope,
} from "../../packages/types/geminiContextCache";

interface CacheCreateParameters {
  readonly model: string;
  readonly config: Readonly<Record<string, unknown>>;
}

let createdCount: number = 0;
let listed: CachedContent[] = [];
const create = mock(async (params: CacheCreateParameters): Promise<CachedContent> => {
  createdCount += 1;
  return {
    name: `cachedContents/created-${createdCount}`,
    displayName: String(params.config.displayName),
    expireTime: new Date(Date.now() + GEMINI_CONTEXT_CACHE_TTL_SECONDS * 1_000).toISOString(),
    usageMetadata: { totalTokenCount: 6_864 },
  };
});
const update = mock(async (params: { name: string }): Promise<CachedContent> => ({
  name: params.name,
  expireTime: new Date(Date.now() + GEMINI_CONTEXT_CACHE_TTL_SECONDS * 1_000).toISOString(),
}));
const remove = mock(async (..._args: unknown[]): Promise<object> => ({}));
const list = mock(async (..._args: unknown[]): Promise<AsyncIterable<CachedContent>> => ({
  async *[Symbol.asyncIterator](): AsyncGenerator<CachedContent> {
    for (const cache of listed) yield cache;
  },
}));
const reportAiCacheUsage = mock((..._args: unknown[]): void => {});
const loggerError = mock((..._args: unknown[]): void => {});
const loggerWarn = mock((..._args: unknown[]): void => {});
const fakeClient: { caches: object } = { caches: { create, update, delete: remove, list } };

mock.module("../../packages/aiChat/gemini/client", () => ({
  getGeminiClient: () => fakeClient,
}));
mock.module("../../packages/infra/aiCacheUsage", () => ({ reportAiCacheUsage, reportGeminiUsage: (): void => {} }));
mock.module("../../packages/infra/logger", () => ({
  logger: loggerStub({ error: loggerError, warn: loggerWarn }),
}));

const {
  acquireGeminiContextCache,
  geminiContextCacheContent,
  isGeminiContextCacheRejection,
  releaseGeminiContextCache,
} = await import("../../packages/infra/geminiContextCache");
const {
  GEMINI_CONTEXT_CACHE_MIN_REMAINING_MS,
  GEMINI_CONTEXT_CACHE_RENEW_BEFORE_MS,
  GEMINI_CONTEXT_CACHE_RETRY_AFTER_MS,
  GEMINI_CONTEXT_CACHE_TTL_SECONDS,
} = await import("../../packages/consts/geminiContextCache");
const { GEMINI_SERVER_TOOL_CONFIG } = await import("../../packages/consts/aiChat/gemini");
const { TEXT_GEMINI_CONTEXT_CACHE_SCOPE } = await import("../../packages/aiChat/gemini/contextCache");
const { textGeminiContextCache } = await import("../../packages/cache/workers/aiChat/geminiContextCache");
const { aiChatWorkerAbortController } = await import("../../packages/cache/workers/aiChat/worker");
const { AD_DETECT_GEMINI_CONTEXT_CACHE_SCOPE } = await import("../../packages/antiRaid/ai/google");
const { adDetectGeminiContextCache } = await import("../../packages/cache/workers/antiRaid/geminiContextCache");
const { adDetectGoogleClientHolder } = await import("../../packages/cache/workers/antiRaid/google");
const { antiRaidDispatchAbort } = await import("../../packages/cache/workers/antiRaid/tasks");
const { quiesceAntiRaidDispatch } = await import("../../packages/workers/antiRaid/taskTracker");
const { adoptAdDetectAgentConfig } = await import("../../packages/config/agent");

adoptAdDetectAgentConfig({ provider: "google", apiKey: "fixture-key", baseUrl: undefined, headers: undefined, model: "gemini-test" });

/** 一个被测 scope：真实 scope 对象，外加换表与停机的测试操作。 */
interface ScopeFixture {
  readonly label: string;
  readonly scope: Readonly<GeminiContextCacheScope>;
  /** 模拟配置热重载：丢弃当前登记表。 */
  readonly dropRegistry: () => void;
  /** 模拟停机：让 scope.signal() 返回已 abort 的信号。 */
  readonly abort: () => void;
  /** 恢复一个未 abort 的信号。 */
  readonly restoreSignal: () => void;
  /** 本 scope 的请求是否带工具声明。 */
  readonly withTools: boolean;
}

const SCOPES: readonly ScopeFixture[] = [
  {
    label: "text",
    scope: TEXT_GEMINI_CONTEXT_CACHE_SCOPE,
    dropRegistry: (): void => {
      textGeminiContextCache.current = null;
    },
    abort: (): void => aiChatWorkerAbortController.current.abort(),
    restoreSignal: (): void => {
      aiChatWorkerAbortController.current = new AbortController();
    },
    withTools: true,
  },
  {
    label: "ad_detect",
    scope: AD_DETECT_GEMINI_CONTEXT_CACHE_SCOPE,
    dropRegistry: (): void => {
      adDetectGeminiContextCache.current = null;
      adDetectGoogleClientHolder.current = fakeClient as unknown as GoogleGenAI;
    },
    abort: (): void => quiesceAntiRaidDispatch(),
    restoreSignal: (): void => {
      antiRaidDispatchAbort.current = null;
    },
    withTools: false,
  },
];

const TOOLS: Tool[] = [{ googleSearch: {} }, { functionDeclarations: [{ name: "fixture_tool", description: "夹具工具" }] }];

describe.each([...SCOPES])("scope $label", (fixture: ScopeFixture) => {
  const scope: Readonly<GeminiContextCacheScope> = fixture.scope;

  function content(systemInstruction: string = "系统指令", tools: Tool[] = TOOLS): GeminiContextCacheContent {
    return fixture.withTools
      ? geminiContextCacheContent({ model: "gemini-test", systemInstruction, tools, toolConfig: GEMINI_SERVER_TOOL_CONFIG })
      : geminiContextCacheContent({ model: "gemini-test", systemInstruction });
  }

  function registry(): GeminiContextCacheRegistry {
    return scope.registry();
  }

  function displayNameOf(entry: GeminiContextCacheContent): string {
    return `${scope.displayNamePrefix}${entry.slotKey}:${entry.contentKey}`;
  }

  /** 跑完启动扫描：第一次调用只触发扫描、返回 null。 */
  async function finishScan(): Promise<void> {
    expect(acquireGeminiContextCache(scope, content())).toBeNull();
    expect(await waitUntil((): boolean => registry().scan === "done")).toBe(true);
  }

  async function settleCreations(): Promise<void> {
    await Promise.allSettled([...registry().creations.values()]);
    await Bun.sleep(0);
  }

  /** 建好默认内容的条目并返回它的槽键。 */
  async function createDefault(): Promise<string> {
    await finishScan();
    acquireGeminiContextCache(scope, content());
    await settleCreations();
    return content().slotKey;
  }

  beforeEach(() => {
    fixture.dropRegistry();
    fixture.restoreSignal();
    createdCount = 0;
    listed = [];
    for (const fn of [create, update, remove, list, reportAiCacheUsage, loggerError, loggerWarn]) fn.mockReset();
    create.mockImplementation(async (params: CacheCreateParameters): Promise<CachedContent> => {
      createdCount += 1;
      return {
        name: `cachedContents/created-${createdCount}`,
        displayName: String(params.config.displayName),
        expireTime: new Date(Date.now() + GEMINI_CONTEXT_CACHE_TTL_SECONDS * 1_000).toISOString(),
        usageMetadata: { totalTokenCount: 6_864 },
      };
    });
    update.mockImplementation(async (params: { name: string }): Promise<CachedContent> => ({
      name: params.name,
      expireTime: new Date(Date.now() + GEMINI_CONTEXT_CACHE_TTL_SECONDS * 1_000).toISOString(),
    }));
    remove.mockImplementation(async (): Promise<object> => ({}));
    list.mockImplementation(async (): Promise<AsyncIterable<CachedContent>> => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<CachedContent> {
        for (const cache of listed) yield cache;
      },
    }));
  });

  afterEach(() => {
    setSystemTime();
    fixture.restoreSignal();
  });

  describe("启动扫描", () => {
    test("第一次调用只触发扫描；带本 scope 前缀的条目按槽接管，其余不碰", async () => {
      const entry: GeminiContextCacheContent = content();
      listed = [
        {
          name: "cachedContents/adopted",
          displayName: displayNameOf(entry),
          expireTime: new Date(Date.now() + GEMINI_CONTEXT_CACHE_TTL_SECONDS * 1_000).toISOString(),
        },
        { name: "cachedContents/foreign", displayName: "someone-else", expireTime: new Date(Date.now() + 3_600_000).toISOString() },
      ];
      await finishScan();

      expect(list).toHaveBeenCalledTimes(1);
      expect(registry().slots.get(entry.slotKey)).toMatchObject({ name: "cachedContents/adopted", lastUsedAt: 0, renewFailedAt: 0 });
      expect(acquireGeminiContextCache(scope, entry)).toBe("cachedContents/adopted");
      expect(registry().slots.get(entry.slotKey)!.lastUsedAt).toBeGreaterThan(0);
      expect(create).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    });

    test("其它 scope 前缀的条目不接管", async () => {
      const entry: GeminiContextCacheContent = content();
      const others: readonly string[] = SCOPES
        .map((other: ScopeFixture): string => other.scope.displayNamePrefix)
        .filter((prefix: string): boolean => prefix !== scope.displayNamePrefix);
      listed = [...others, "copy-ninjia:other:"].map((prefix: string, index: number): CachedContent => ({
        name: `cachedContents/foreign-${index}`,
        displayName: `${prefix}${entry.slotKey}:${entry.contentKey}`,
        expireTime: new Date(Date.now() + 3_600_000).toISOString(),
      }));
      await finishScan();

      expect(registry().slots.size).toBe(0);
      expect(remove).not.toHaveBeenCalled();
    });

    test("同槽出现多份时留过期更晚的一份，删掉其余", async () => {
      const displayName: string = displayNameOf(content());
      listed = [
        { name: "cachedContents/older", displayName, expireTime: new Date(Date.now() + 1_800_000).toISOString() },
        { name: "cachedContents/newer", displayName, expireTime: new Date(Date.now() + 3_600_000).toISOString() },
      ];
      await finishScan();

      expect(registry().slots.get(content().slotKey)!.name).toBe("cachedContents/newer");
      expect(remove).toHaveBeenCalledWith(expect.objectContaining({ name: "cachedContents/older" }));
    });

    test("扫描失败只记日志，之后照常按需创建", async () => {
      list.mockImplementationOnce(async (): Promise<AsyncIterable<CachedContent>> => {
        throw new Error("list failed");
      });
      await finishScan();
      expect(loggerError).toHaveBeenCalledTimes(1);

      expect(acquireGeminiContextCache(scope, content())).toBeNull();
      await settleCreations();
      expect(create).toHaveBeenCalledTimes(1);
    });
  });

  describe("按槽创建与引用", () => {
    test("未命中时后台创建，只装本 scope 的缓存内容；创建的 token 按命中 0 上报", async () => {
      await finishScan();
      const entry: GeminiContextCacheContent = content();

      expect(acquireGeminiContextCache(scope, entry)).toBeNull();
      // 创建进行中：同槽不重复创建，本次照常走完整请求。
      expect(acquireGeminiContextCache(scope, entry)).toBeNull();
      await settleCreations();

      expect(create).toHaveBeenCalledTimes(1);
      const params: CacheCreateParameters = create.mock.calls[0]![0];
      expect(params.model).toBe("gemini-test");
      expect(params.config).toMatchObject({
        ttl: `${GEMINI_CONTEXT_CACHE_TTL_SECONDS}s`,
        displayName: displayNameOf(entry),
        systemInstruction: "系统指令",
      });
      expect(params.config.tools).toEqual(fixture.withTools ? TOOLS : undefined);
      expect(params.config.toolConfig).toEqual(fixture.withTools ? GEMINI_SERVER_TOOL_CONFIG : undefined);
      expect(params.config.contents).toBeUndefined();
      expect(reportAiCacheUsage).toHaveBeenCalledWith(expect.objectContaining({
        capability: scope.capability,
        provider: "google",
        model: "gemini-test",
        inputTokens: 6_864,
        cachedInputTokens: 0,
        outputTokens: 0,
      }));
      expect(acquireGeminiContextCache(scope, entry)).toBe("cachedContents/created-1");
    });

    test("同槽内容变了（模型换了）就新建条目并删掉旧的服务端条目", async () => {
      await createDefault();

      const changed: GeminiContextCacheContent = geminiContextCacheContent({
        ...content(),
        model: "gemini-next",
      });
      expect(changed.slotKey).toBe(content().slotKey);
      expect(acquireGeminiContextCache(scope, changed)).toBeNull();
      await settleCreations();

      expect(acquireGeminiContextCache(scope, changed)).toBe("cachedContents/created-2");
      expect(remove).toHaveBeenCalledWith(expect.objectContaining({ name: "cachedContents/created-1" }));
      expect(registry().slots.size).toBe(1);
    });

    test("新建成功后删掉接管以来从未用过的条目", async () => {
      const stale: GeminiContextCacheContent = content("旧系统指令");
      listed = [{
        name: "cachedContents/stale",
        displayName: displayNameOf(stale),
        expireTime: new Date(Date.now() + 3_600_000).toISOString(),
      }];
      await createDefault();

      expect(registry().slots.has(stale.slotKey)).toBe(false);
      expect(remove).toHaveBeenCalledWith(expect.objectContaining({ name: "cachedContents/stale" }));
    });

    test("剩余存活不足下限时按未命中处理，重建", async () => {
      const slotKey: string = await createDefault();

      registry().slots.get(slotKey)!.expireAt = Date.now() + GEMINI_CONTEXT_CACHE_MIN_REMAINING_MS - 1;
      expect(acquireGeminiContextCache(scope, content())).toBeNull();
      await settleCreations();
      expect(create).toHaveBeenCalledTimes(2);
    });

    test("新条目的剩余存活高于续期档：刚建成时命中不续期", async () => {
      await createDefault();
      expect(acquireGeminiContextCache(scope, content())).toBe("cachedContents/created-1");
      expect(update).not.toHaveBeenCalled();
    });

    test("释放后摘掉本地登记并删除服务端条目，冷却期内不重建，过了冷却期再按未命中重建", async () => {
      await createDefault();
      const start: number = Date.now();
      setSystemTime(new Date(start));

      releaseGeminiContextCache(scope, "cachedContents/created-1");
      expect(registry().slots.size).toBe(0);
      expect(remove).toHaveBeenCalledWith(expect.objectContaining({ name: "cachedContents/created-1" }));
      expect(acquireGeminiContextCache(scope, content())).toBeNull();
      await settleCreations();
      expect(create).toHaveBeenCalledTimes(1);

      setSystemTime(new Date(start + GEMINI_CONTEXT_CACHE_RETRY_AFTER_MS));
      expect(acquireGeminiContextCache(scope, content())).toBeNull();
      await settleCreations();
      expect(acquireGeminiContextCache(scope, content())).toBe("cachedContents/created-2");
    });

    test("释放一个不在当前登记表里的资源名什么都不做", async () => {
      await createDefault();
      releaseGeminiContextCache(scope, "cachedContents/unknown");
      expect(registry().slots.size).toBe(1);
      expect(registry().failures.size).toBe(0);
      expect(remove).not.toHaveBeenCalled();
    });

    test("删除一个已不存在的条目（404）不记错误日志", async () => {
      remove.mockImplementationOnce(async (): Promise<object> => {
        throw new ApiError({ message: "not found", status: 404 });
      });
      await createDefault();
      releaseGeminiContextCache(scope, "cachedContents/created-1");
      await Bun.sleep(0);
      expect(loggerError).not.toHaveBeenCalled();
    });

    test("超过槽数上限时删掉最久未用的槽", async () => {
      await finishScan();
      for (let index: number = 0; index <= scope.maxSlots; index++) {
        acquireGeminiContextCache(scope, content(`系统指令 ${index}`));
        await settleCreations();
        await Bun.sleep(2);
      }

      expect(registry().slots.size).toBe(scope.maxSlots);
      expect(registry().slots.has(content("系统指令 0").slotKey)).toBe(false);
      expect(remove).toHaveBeenCalledWith(expect.objectContaining({ name: "cachedContents/created-1" }));
    });
  });

  describe("创建失败", () => {
    test("瞬时失败后冷却期内不再为该槽创建，过了冷却期再试", async () => {
      create.mockImplementationOnce(async (): Promise<CachedContent> => {
        throw new ApiError({ message: "unavailable", status: 503 });
      });
      await finishScan();
      const start: number = Date.now();
      setSystemTime(new Date(start));
      acquireGeminiContextCache(scope, content());
      await settleCreations();
      expect(loggerError).toHaveBeenCalledTimes(1);

      expect(acquireGeminiContextCache(scope, content())).toBeNull();
      await settleCreations();
      expect(create).toHaveBeenCalledTimes(1);

      setSystemTime(new Date(start + GEMINI_CONTEXT_CACHE_RETRY_AFTER_MS));
      acquireGeminiContextCache(scope, content());
      await settleCreations();
      expect(create).toHaveBeenCalledTimes(2);
    });

    test("墙钟回拨到失败时刻之前按冷却已结束处理", async () => {
      create.mockImplementationOnce(async (): Promise<CachedContent> => {
        throw new Error("network down");
      });
      await finishScan();
      const start: number = Date.now();
      setSystemTime(new Date(start));
      acquireGeminiContextCache(scope, content());
      await settleCreations();

      setSystemTime(new Date(start - 1));
      acquireGeminiContextCache(scope, content());
      await settleCreations();
      expect(create).toHaveBeenCalledTimes(2);
    });

    test("被 400 拒绝后同一内容不再创建、只记 warn；内容变了再试", async () => {
      create.mockImplementationOnce(async (): Promise<CachedContent> => {
        throw new ApiError({ message: "Cached content is too small", status: 400 });
      });
      await finishScan();
      const start: number = Date.now();
      setSystemTime(new Date(start));
      acquireGeminiContextCache(scope, content());
      await settleCreations();
      expect(loggerWarn).toHaveBeenCalledTimes(1);
      expect(loggerError).not.toHaveBeenCalled();

      setSystemTime(new Date(start + GEMINI_CONTEXT_CACHE_RETRY_AFTER_MS * 10));
      expect(acquireGeminiContextCache(scope, content())).toBeNull();
      await settleCreations();
      expect(create).toHaveBeenCalledTimes(1);

      const changed: GeminiContextCacheContent = geminiContextCacheContent({ ...content(), model: "gemini-next" });
      acquireGeminiContextCache(scope, changed);
      await settleCreations();
      expect(create).toHaveBeenCalledTimes(2);
      expect(registry().rejected.size).toBe(0);
    });

    test("多于槽数上限的槽同时失败时，每个槽各自保留冷却与被拒记录", async () => {
      create.mockImplementation(async (params: CacheCreateParameters): Promise<CachedContent> => {
        if (String(params.config.systemInstruction).startsWith("小")) {
          throw new ApiError({ message: "Cached content is too small", status: 400 });
        }
        throw new ApiError({ message: "unavailable", status: 503 });
      });
      await finishScan();
      const instructions: readonly string[] = Array.from(
        { length: scope.maxSlots + 1 },
        (_unused: unknown, index: number): string => (index % 2 === 0 ? `小指令 ${index}` : `系统指令 ${index}`)
      );
      for (const instruction of instructions) {
        acquireGeminiContextCache(scope, content(instruction));
        await settleCreations();
      }
      expect(create).toHaveBeenCalledTimes(instructions.length);

      for (const instruction of instructions) {
        expect(acquireGeminiContextCache(scope, content(instruction))).toBeNull();
        await settleCreations();
      }
      expect(create).toHaveBeenCalledTimes(instructions.length);
      expect(registry().failures.size + registry().rejected.size).toBe(instructions.length);
    });
  });

  describe("续期", () => {
    test("命中时剩余存活低于续期档，后台续期且同时只续一次", async () => {
      const slotKey: string = await createDefault();

      registry().slots.get(slotKey)!.expireAt = Date.now() + GEMINI_CONTEXT_CACHE_RENEW_BEFORE_MS - 1;
      expect(acquireGeminiContextCache(scope, content())).toBe("cachedContents/created-1");
      expect(acquireGeminiContextCache(scope, content())).toBe("cachedContents/created-1");
      expect(await waitUntil((): boolean => !registry().slots.get(slotKey)!.renewing)).toBe(true);

      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith(expect.objectContaining({
        name: "cachedContents/created-1",
        config: expect.objectContaining({ ttl: `${GEMINI_CONTEXT_CACHE_TTL_SECONDS}s` }),
      }));
      expect(registry().slots.get(slotKey)!.expireAt - Date.now()).toBeGreaterThan(GEMINI_CONTEXT_CACHE_RENEW_BEFORE_MS);
    });

    test("续期失败后冷却期内命中不再续期，过了冷却期再续", async () => {
      update.mockImplementation(async (): Promise<CachedContent> => {
        throw new ApiError({ message: "permission denied", status: 403 });
      });
      const slotKey: string = await createDefault();
      const start: number = Date.now();
      setSystemTime(new Date(start));
      registry().slots.get(slotKey)!.expireAt = start + GEMINI_CONTEXT_CACHE_RENEW_BEFORE_MS - 1;

      for (let index: number = 0; index < 20; index++) {
        expect(acquireGeminiContextCache(scope, content())).toBe("cachedContents/created-1");
        await waitUntil((): boolean => !registry().slots.get(slotKey)!.renewing);
      }
      expect(update).toHaveBeenCalledTimes(1);
      expect(loggerError).toHaveBeenCalledTimes(1);
      expect(registry().slots.get(slotKey)!.renewFailedAt).toBe(start);

      setSystemTime(new Date(start + GEMINI_CONTEXT_CACHE_RETRY_AFTER_MS));
      registry().slots.get(slotKey)!.expireAt = start + GEMINI_CONTEXT_CACHE_RETRY_AFTER_MS + GEMINI_CONTEXT_CACHE_RENEW_BEFORE_MS - 1;
      acquireGeminiContextCache(scope, content());
      await waitUntil((): boolean => !registry().slots.get(slotKey)!.renewing);
      expect(update).toHaveBeenCalledTimes(2);
    });

    test("续期成功后清掉失败时刻", async () => {
      update.mockImplementationOnce(async (): Promise<CachedContent> => {
        throw new Error("network down");
      });
      const slotKey: string = await createDefault();
      const start: number = Date.now();
      setSystemTime(new Date(start));
      registry().slots.get(slotKey)!.expireAt = start + GEMINI_CONTEXT_CACHE_RENEW_BEFORE_MS - 1;
      acquireGeminiContextCache(scope, content());
      await waitUntil((): boolean => !registry().slots.get(slotKey)!.renewing);
      expect(registry().slots.get(slotKey)!.renewFailedAt).toBe(start);

      setSystemTime(new Date(start + GEMINI_CONTEXT_CACHE_RETRY_AFTER_MS));
      registry().slots.get(slotKey)!.expireAt = start + GEMINI_CONTEXT_CACHE_RETRY_AFTER_MS + GEMINI_CONTEXT_CACHE_RENEW_BEFORE_MS - 1;
      acquireGeminiContextCache(scope, content());
      await waitUntil((): boolean => !registry().slots.get(slotKey)!.renewing);
      expect(registry().slots.get(slotKey)!.renewFailedAt).toBe(0);
    });

    test("墙钟回拨到续期失败之前按冷却已结束处理", async () => {
      update.mockImplementationOnce(async (): Promise<CachedContent> => {
        throw new Error("network down");
      });
      const slotKey: string = await createDefault();
      const start: number = Date.now();
      setSystemTime(new Date(start));
      registry().slots.get(slotKey)!.expireAt = start + GEMINI_CONTEXT_CACHE_RENEW_BEFORE_MS - 1;
      acquireGeminiContextCache(scope, content());
      await waitUntil((): boolean => !registry().slots.get(slotKey)!.renewing);

      setSystemTime(new Date(start - 1));
      registry().slots.get(slotKey)!.expireAt = start - 1 + GEMINI_CONTEXT_CACHE_RENEW_BEFORE_MS - 1;
      acquireGeminiContextCache(scope, content());
      await waitUntil((): boolean => !registry().slots.get(slotKey)!.renewing);
      expect(update).toHaveBeenCalledTimes(2);
    });

    test("续期报 404 时静默摘掉本地登记，下一次按未命中重建", async () => {
      update.mockImplementationOnce(async (): Promise<CachedContent> => {
        throw new ApiError({ message: "not found", status: 404 });
      });
      const slotKey: string = await createDefault();
      registry().slots.get(slotKey)!.expireAt = Date.now() + GEMINI_CONTEXT_CACHE_RENEW_BEFORE_MS - 1;
      expect(acquireGeminiContextCache(scope, content())).toBe("cachedContents/created-1");
      expect(await waitUntil((): boolean => !registry().slots.has(slotKey))).toBe(true);
      expect(loggerError).not.toHaveBeenCalled();

      expect(acquireGeminiContextCache(scope, content())).toBeNull();
      await settleCreations();
      expect(acquireGeminiContextCache(scope, content())).toBe("cachedContents/created-2");
    });
  });

  describe("换表与停机", () => {
    test("丢弃登记表后重新扫描；旧表上的在途创建只写旧表", async () => {
      await finishScan();
      let resolveCreate: (cache: CachedContent) => void = (): void => {};
      create.mockImplementationOnce((): Promise<CachedContent> => new Promise<CachedContent>((resolve) => {
        resolveCreate = resolve;
      }));
      acquireGeminiContextCache(scope, content());
      const previous: GeminiContextCacheRegistry = registry();
      expect(previous.creations.size).toBe(1);

      fixture.dropRegistry();
      await finishScan();
      expect(list).toHaveBeenCalledTimes(2);

      resolveCreate({
        name: "cachedContents/stale-registry",
        expireTime: new Date(Date.now() + 3_600_000).toISOString(),
      });
      await Promise.allSettled([...previous.creations.values()]);
      await Bun.sleep(0);
      expect(previous.slots.get(content().slotKey)!.name).toBe("cachedContents/stale-registry");
      expect(registry()).not.toBe(previous);
      expect(registry().slots.size).toBe(0);
    });

    test("停机后后台请求随信号取消：不记日志、不记失败", async () => {
      await finishScan();
      create.mockImplementationOnce(async (params: CacheCreateParameters): Promise<CachedContent> => {
        fixture.abort();
        const signal: AbortSignal = params.config.abortSignal as AbortSignal;
        expect(signal.aborted).toBe(true);
        throw signal.reason;
      });
      acquireGeminiContextCache(scope, content());
      await settleCreations();

      expect(loggerError).not.toHaveBeenCalled();
      expect(registry().failures.size).toBe(0);
    });
  });
});

/**
 * 两个 scope 句柄构造后只读：断言写在不会被调用的闭包内，`@ts-expect-error` 只在编译期
 * 生效，只读性一旦失效就会变成「未使用的抑制」而让 typecheck 失败。
 */
test("scope 句柄的字段与方法都不能被调用方替换", () => {
  const assertScopesReadonly = (): void => {
    // @ts-expect-error 调用方不能改 text scope 的槽数上限。
    TEXT_GEMINI_CONTEXT_CACHE_SCOPE.maxSlots = 1;
    // @ts-expect-error 调用方不能改 ad_detect scope 的 displayName 前缀。
    AD_DETECT_GEMINI_CONTEXT_CACHE_SCOPE.displayNamePrefix = "copy-ninjia:text:";
    // @ts-expect-error 调用方不能替换登记表取用方法。
    AD_DETECT_GEMINI_CONTEXT_CACHE_SCOPE.registry = TEXT_GEMINI_CONTEXT_CACHE_SCOPE.registry;
  };
  expect(typeof assertScopesReadonly).toBe("function");
});

describe("isGeminiContextCacheRejection", () => {
  test("408/429 以外的 4xx 算拒绝；端点故障与非 ApiError 不算", () => {
    for (const status of [400, 403, 404, 405]) {
      expect(isGeminiContextCacheRejection(new ApiError({ message: "rejected", status }))).toBe(true);
    }
    for (const status of [408, 429, 500, 503]) {
      expect(isGeminiContextCacheRejection(new ApiError({ message: "failure", status }))).toBe(false);
    }
    expect(isGeminiContextCacheRejection(new Error("network down"))).toBe(false);
  });
});
