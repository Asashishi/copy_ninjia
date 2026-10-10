/**
 * Gemini 显式缓存（cachedContent）的共用核心，与能力无关：槽登记、启动扫描、后台创建、
 * 续期、释放与淘汰。调用方传入自己的 scope（types/geminiContextCache.ts）：text 在
 * aiChat/gemini/contextCache.ts，ad_detect 在 workers/antiRaid/adDetect/ai/google.ts，各自的登记表放在
 * 所在线程的 cache 里。
 *
 * 按系统指令分槽：槽键是系统指令的指纹；槽里记着当前条目的内容键（模型、系统指令、
 * 工具声明、toolConfig 的指纹），同槽内容变了就新建条目并删除旧的服务端条目。
 *
 * 引用从不等待：acquireGeminiContextCache 同步返回可用条目的资源名，或返回 null 让本次
 * 走完整请求，同时在后台完成该做的事：登记表第一次被取用时触发启动扫描，按 displayName
 * 接管服务端已有的本 scope 条目；未命中时后台创建（同槽同时只创建一次）；命中且剩余存活
 * 不足 GEMINI_CONTEXT_CACHE_RENEW_BEFORE_MS 时后台续期。
 *
 * 失败口径：创建被端点以 400 拒绝时记下该槽
 * 的内容键与累计次数，只记 warn；未满 GEMINI_CONTEXT_CACHE_MAX_REJECTIONS 次时
 * GEMINI_CONTEXT_CACHE_REJECTION_RETRY_AFTER_MS 后再试，满额后同一内容不再创建。其余创建失败、
 * 续期失败以及引用被拒后的释放，都在 GEMINI_CONTEXT_CACHE_RETRY_AFTER_MS 内不再重发同一种
 * 请求（两种冷却遇墙钟回拨都按已结束处理，见 libs/clockWindow.ts）。删除或续期报本凭据已访问
 * 不到该条目（404 或 403，见 isGeminiContextCacheGone）时不记错误，续期还会静默摘掉本地登记。
 *
 * 服务端条目 TTL 为 GEMINI_CONTEXT_CACHE_TTL_SECONDS，到期由 Google 自动删除；本模块在换
 * 内容、新建后发现接管以来从未用过的条目、超出槽数上限时主动删除。创建时的输入 token
 * 经 reportAiCacheUsage 以 scope.capability、命中 0、写入等于输入上报。后台请求在发起时取
 * scope.signal()，停机时一并取消。
 */

import { ApiError } from "@google/genai";
import type { CachedContent, GoogleGenAI, Pager, Tool, ToolConfig } from "@google/genai";
import {
  GEMINI_CONTEXT_CACHE_KEY_PATTERN,
  GEMINI_CONTEXT_CACHE_LIST_PAGE_SIZE,
  GEMINI_CONTEXT_CACHE_MAX_REJECTIONS,
  GEMINI_CONTEXT_CACHE_MIN_REMAINING_MS,
  GEMINI_CONTEXT_CACHE_REJECTION_RETRY_AFTER_MS,
  GEMINI_CONTEXT_CACHE_RENEW_BEFORE_MS,
  GEMINI_CONTEXT_CACHE_RETRY_AFTER_MS,
  GEMINI_CONTEXT_CACHE_TTL,
  GEMINI_CONTEXT_CACHE_TTL_SECONDS,
} from "../consts/geminiContextCache";
import { isRecordedWithin } from "../libs/clockWindow";
import { stablePrefixFingerprint } from "../libs/prefixFingerprint";
import { reportAiCacheUsage } from "./aiCacheUsage";
import { logger } from "./logger";
import type {
  GeminiContextCacheContent,
  GeminiContextCacheRegistry,
  GeminiContextCacheRejection,
  GeminiContextCacheScope,
  GeminiContextCacheSlot,
} from "../types/geminiContextCache";

/** 一份要缓存的内容；工具声明与 toolConfig 只有 text 使用。 */
export interface GeminiContextCacheContentParams {
  readonly model: string;
  readonly systemInstruction: string;
  readonly tools?: Tool[];
  readonly toolConfig?: Readonly<ToolConfig>;
}

/** displayName 里解析出的两段指纹。 */
interface ParsedDisplayName {
  readonly slotKey: string;
  readonly contentKey: string;
}

/** 新建一张空登记表，绑定给定的客户端；扫描从 "idle" 起步。 */
export function createGeminiContextCacheRegistry(client: GoogleGenAI): GeminiContextCacheRegistry {
  return {
    client,
    slots: new Map<string, GeminiContextCacheSlot>(),
    creations: new Map<string, Promise<void>>(),
    failures: new Map<string, number>(),
    rejected: new Map<string, GeminiContextCacheRejection>(),
    scan: "idle",
  };
}

/** 算出一份内容的槽键与内容键；调用方可以把结果随内容一起缓存，免去每次重算。 */
export function geminiContextCacheContent({
  model,
  systemInstruction,
  tools,
  toolConfig,
}: GeminiContextCacheContentParams): GeminiContextCacheContent {
  return {
    model,
    systemInstruction,
    tools,
    toolConfig,
    slotKey: stablePrefixFingerprint([systemInstruction]),
    contentKey: stablePrefixFingerprint([
      model,
      systemInstruction,
      JSON.stringify(tools ?? null),
      JSON.stringify(toolConfig ?? null),
    ]),
  };
}

/**
 * 引用缓存的请求被端点拒绝时是否应释放登记并按完整请求补发：408/429 以外的 4xx
 * （条目不存在、已过期、无权访问或引用非法）。端点故障（无状态码、408/429/5xx）不算。
 */
export function isGeminiContextCacheRejection(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const status: number = error.status;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** 服务端给的过期时刻；缺失或无法解析时用 fallback。 */
function expireAtOf(cache: CachedContent, fallback: number): number {
  const parsed: number = cache.expireTime === undefined ? Number.NaN : Date.parse(cache.expireTime);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseDisplayName(prefix: string, displayName: string | undefined): ParsedDisplayName | null {
  if (displayName?.startsWith(prefix) !== true) return null;
  const keys: string[] = displayName.slice(prefix.length).split(":");
  const slotKey: string | undefined = keys[0];
  const contentKey: string | undefined = keys[1];
  if (keys.length !== 2 || slotKey === undefined || contentKey === undefined) return null;
  if (!GEMINI_CONTEXT_CACHE_KEY_PATTERN.test(slotKey) || !GEMINI_CONTEXT_CACHE_KEY_PATTERN.test(contentKey)) return null;
  return { slotKey, contentKey };
}

/**
 * 删除或续期的报错是否表示本凭据已访问不到该条目：404，或 Gemini 对「不存在或无权访问」
 * 统一返回的 403（"CachedContent not found (or permission denied)"）。
 */
function isGeminiContextCacheGone(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 403);
}

/** 后台删除一个服务端条目；本凭据已访问不到该条目（见 isGeminiContextCacheGone）或停机取消时静默。 */
function deleteRemote(scope: Readonly<GeminiContextCacheScope>, registry: GeminiContextCacheRegistry, name: string): void {
  const signal: AbortSignal = scope.signal();
  void (async (): Promise<void> => {
    try {
      await registry.client.caches.delete({ name, config: { abortSignal: signal } });
    } catch (error: unknown) {
      if (signal.aborted || isGeminiContextCacheGone(error)) return;
      logger.error(`${scope.errorLabel} delete failed:`, error);
    }
  })();
}

/** 超过槽数上限时按 lastUsedAt 删掉最久未用的槽。 */
function evictOverflowSlots(scope: Readonly<GeminiContextCacheScope>, registry: GeminiContextCacheRegistry): void {
  while (registry.slots.size > scope.maxSlots) {
    let oldestKey: string | undefined;
    let oldestUse: number = Number.POSITIVE_INFINITY;
    for (const [key, slot] of registry.slots) {
      if (slot.lastUsedAt < oldestUse) {
        oldestUse = slot.lastUsedAt;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) return;
    const oldest: GeminiContextCacheSlot = registry.slots.get(oldestKey)!;
    registry.slots.delete(oldestKey);
    registry.failures.delete(oldestKey);
    registry.rejected.delete(oldestKey);
    deleteRemote(scope, registry, oldest.name);
  }
}

/**
 * 启动扫描：接管服务端已有的本 scope 条目（displayName 带本 scope 前缀、两段指纹合法）。
 * 同槽出现多份时留过期更晚的一份、删掉其余。接管的条目 lastUsedAt 为 0。
 */
async function scanExistingCaches(scope: Readonly<GeminiContextCacheScope>, registry: GeminiContextCacheRegistry): Promise<void> {
  const signal: AbortSignal = scope.signal();
  try {
    const pager: Pager<CachedContent> = await registry.client.caches.list({
      config: { pageSize: GEMINI_CONTEXT_CACHE_LIST_PAGE_SIZE, abortSignal: signal },
    });
    for await (const cache of pager) {
      const parsed: ParsedDisplayName | null = parseDisplayName(scope.displayNamePrefix, cache.displayName);
      if (parsed === null || cache.name === undefined) continue;
      const incoming: GeminiContextCacheSlot = {
        contentKey: parsed.contentKey,
        name: cache.name,
        expireAt: expireAtOf(cache, 0),
        lastUsedAt: 0,
        renewing: false,
        renewFailedAt: 0,
      };
      const existing: GeminiContextCacheSlot | undefined = registry.slots.get(parsed.slotKey);
      if (existing === undefined) {
        registry.slots.set(parsed.slotKey, incoming);
      } else if (incoming.expireAt > existing.expireAt) {
        registry.slots.set(parsed.slotKey, incoming);
        deleteRemote(scope, registry, existing.name);
      } else {
        deleteRemote(scope, registry, incoming.name);
      }
    }
    evictOverflowSlots(scope, registry);
  } catch (error: unknown) {
    if (!signal.aborted) logger.error(`${scope.errorLabel} list failed:`, error);
  } finally {
    registry.scan = "done";
  }
}

/**
 * 创建一槽的条目并登记。成功后删掉同槽的旧条目与接管以来从未用过的条目，再按槽数上限
 * 淘汰；被 400 拒绝时累计该内容的被拒次数与时刻，其余失败记下时刻。
 */
async function createSlot(
  scope: Readonly<GeminiContextCacheScope>,
  registry: GeminiContextCacheRegistry,
  content: GeminiContextCacheContent
): Promise<void> {
  const signal: AbortSignal = scope.signal();
  const slotKey: string = content.slotKey;
  try {
    const cache: CachedContent = await registry.client.caches.create({
      model: content.model,
      config: {
        abortSignal: signal,
        ttl: GEMINI_CONTEXT_CACHE_TTL,
        displayName: scope.displayNamePrefix + slotKey + ":" + content.contentKey,
        systemInstruction: content.systemInstruction,
        tools: content.tools,
        toolConfig: content.toolConfig,
      },
    });
    reportAiCacheUsage({
      capability: scope.capability,
      provider: "google",
      model: content.model,
      inputTokens: cache.usageMetadata?.totalTokenCount,
      cachedInputTokens: 0,
      cacheWriteInputTokens: cache.usageMetadata?.totalTokenCount,
      outputTokens: 0,
    });
    if (cache.name === undefined) throw new Error("the created cached content has no resource name");
    const now: number = Date.now();
    const previous: GeminiContextCacheSlot | undefined = registry.slots.get(slotKey);
    registry.slots.set(slotKey, {
      contentKey: content.contentKey,
      name: cache.name,
      expireAt: expireAtOf(cache, now + GEMINI_CONTEXT_CACHE_TTL_SECONDS * 1_000),
      lastUsedAt: now,
      renewing: false,
      renewFailedAt: 0,
    });
    registry.failures.delete(slotKey);
    registry.rejected.delete(slotKey);
    if (previous !== undefined && previous.name !== cache.name) deleteRemote(scope, registry, previous.name);
    for (const [key, slot] of registry.slots) {
      if (key === slotKey || slot.lastUsedAt !== 0) continue;
      registry.slots.delete(key);
      deleteRemote(scope, registry, slot.name);
    }
    evictOverflowSlots(scope, registry);
  } catch (error: unknown) {
    if (signal.aborted) return;
    if (error instanceof ApiError && error.status === 400) {
      const previous: GeminiContextCacheRejection | undefined = registry.rejected.get(slotKey);
      const count: number = previous?.contentKey === content.contentKey ? previous.count + 1 : 1;
      registry.rejected.set(slotKey, { contentKey: content.contentKey, count, rejectedAt: Date.now() });
      logger.warn(
        `${scope.errorLabel} create rejected (${count}/${GEMINI_CONTEXT_CACHE_MAX_REJECTIONS}): ` +
        `${error.status} ${error.message}`
      );
      return;
    }
    recordSlotFailure(registry, slotKey, Date.now());
    logger.error(`${scope.errorLabel} create failed:`, error);
  }
}

/**
 * 记下该槽一次失败的时刻，并顺带摘掉已过 GEMINI_CONTEXT_CACHE_RETRY_AFTER_MS 冷却期的
 * 旧记录：过期记录不再影响任何判定。
 */
function recordSlotFailure(registry: GeminiContextCacheRegistry, slotKey: string, now: number): void {
  for (const [key, failedAt] of registry.failures) {
    if (!isRecordedWithin(failedAt, now, GEMINI_CONTEXT_CACHE_RETRY_AFTER_MS - 1)) registry.failures.delete(key);
  }
  registry.failures.set(slotKey, now);
}

/** 登记一次后台创建；结束后只摘除自己那一项。 */
function startCreation(
  scope: Readonly<GeminiContextCacheScope>,
  registry: GeminiContextCacheRegistry,
  content: GeminiContextCacheContent
): void {
  const task: Promise<void> = createSlot(scope, registry, content).finally((): void => {
    if (registry.creations.get(content.slotKey) === task) registry.creations.delete(content.slotKey);
  });
  registry.creations.set(content.slotKey, task);
}

/** 从登记表里摘掉这一条目（若仍在）。 */
function forgetSlot(registry: GeminiContextCacheRegistry, slot: GeminiContextCacheSlot): void {
  for (const [key, entry] of registry.slots) {
    if (entry !== slot) continue;
    registry.slots.delete(key);
    return;
  }
}

/**
 * 后台把条目续期回完整 TTL；同一条目同时只续一次。失败记下时刻；本凭据已访问不到该条目（见
 * isGeminiContextCacheGone）时直接摘掉本地登记，下一次按未命中重建。
 */
function renewSlot(
  scope: Readonly<GeminiContextCacheScope>,
  registry: GeminiContextCacheRegistry,
  slot: GeminiContextCacheSlot
): void {
  slot.renewing = true;
  const signal: AbortSignal = scope.signal();
  void (async (): Promise<void> => {
    try {
      const updated: CachedContent = await registry.client.caches.update({
        name: slot.name,
        config: { ttl: GEMINI_CONTEXT_CACHE_TTL, abortSignal: signal },
      });
      slot.expireAt = expireAtOf(updated, Date.now() + GEMINI_CONTEXT_CACHE_TTL_SECONDS * 1_000);
      slot.renewFailedAt = 0;
    } catch (error: unknown) {
      if (signal.aborted) return;
      if (isGeminiContextCacheGone(error)) {
        forgetSlot(registry, slot);
        return;
      }
      slot.renewFailedAt = Date.now();
      logger.error(`${scope.errorLabel} renew failed:`, error);
    } finally {
      slot.renewing = false;
    }
  })();
}

/**
 * 取本次请求可引用的显式缓存资源名；没有可用条目时返回 null，本次走完整请求，需要的
 * 扫描、创建或续期在后台进行。
 */
export function acquireGeminiContextCache(
  scope: Readonly<GeminiContextCacheScope>,
  content: GeminiContextCacheContent
): string | null {
  const registry: GeminiContextCacheRegistry = scope.registry();
  if (registry.scan === "idle") {
    registry.scan = "running";
    void scanExistingCaches(scope, registry);
    return null;
  }
  const now: number = Date.now();
  const slot: GeminiContextCacheSlot | undefined = registry.slots.get(content.slotKey);
  if (slot?.contentKey === content.contentKey && slot.expireAt - now > GEMINI_CONTEXT_CACHE_MIN_REMAINING_MS) {
    slot.lastUsedAt = now;
    if (
      !slot.renewing &&
      slot.expireAt - now < GEMINI_CONTEXT_CACHE_RENEW_BEFORE_MS &&
      !isRecordedWithin(slot.renewFailedAt, now, GEMINI_CONTEXT_CACHE_RETRY_AFTER_MS - 1)
    ) {
      renewSlot(scope, registry, slot);
    }
    return slot.name;
  }
  if (registry.scan === "running" || registry.creations.has(content.slotKey)) return null;
  const rejection: GeminiContextCacheRejection | undefined = registry.rejected.get(content.slotKey);
  if (
    rejection?.contentKey === content.contentKey && (
      rejection.count >= GEMINI_CONTEXT_CACHE_MAX_REJECTIONS ||
      isRecordedWithin(rejection.rejectedAt, now, GEMINI_CONTEXT_CACHE_REJECTION_RETRY_AFTER_MS - 1)
    )
  ) return null;
  const failedAt: number | undefined = registry.failures.get(content.slotKey);
  if (failedAt !== undefined && isRecordedWithin(failedAt, now, GEMINI_CONTEXT_CACHE_RETRY_AFTER_MS - 1)) return null;
  startCreation(scope, registry, content);
  return null;
}

/**
 * 引用缓存的请求被端点拒绝（条目不存在、已过期或无权访问）后调用：摘掉引用该资源名的
 * 本地登记并尝试删除服务端条目，该槽按创建失败记下时刻，GEMINI_CONTEXT_CACHE_RETRY_AFTER_MS
 * 后再按未命中重建。资源名不在当前登记表里（例如热重载已换表）时什么都不做。
 */
export function releaseGeminiContextCache(scope: Readonly<GeminiContextCacheScope>, name: string): void {
  const registry: GeminiContextCacheRegistry = scope.registry();
  for (const [key, slot] of registry.slots) {
    if (slot.name !== name) continue;
    registry.slots.delete(key);
    recordSlotFailure(registry, key, Date.now());
    deleteRemote(scope, registry, name);
    return;
  }
}
