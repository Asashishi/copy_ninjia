import type { GoogleGenAI, Tool, ToolConfig } from "@google/genai";
import type { AiCacheCapability } from "./aiCache";

/**
 * 一槽显式缓存的本地登记（见 infra/geminiContextCache.ts）。字段在创建与启动接管两处
 * 一次写全；命中、续期只改 expireAt / lastUsedAt / renewing / renewFailedAt 四项。
 */
export interface GeminiContextCacheSlot {
  /** 缓存内容（模型、系统指令、工具声明、toolConfig）的指纹；同槽内容变了就换条目。 */
  readonly contentKey: string;
  /** 服务端资源名 `cachedContents/…`，请求里作为 cachedContent 引用。 */
  readonly name: string;
  /** 服务端过期时刻（epoch 毫秒）；续期成功后改写。 */
  expireAt: number;
  /** 最近一次被请求引用的时刻（epoch 毫秒）；启动扫描接管、尚未用过的为 0。 */
  lastUsedAt: number;
  /** 是否有续期请求在途；同一条目同时只续期一次。 */
  renewing: boolean;
  /**
   * 最近一次续期失败的时刻（epoch 毫秒），0 表示没有；此后
   * GEMINI_CONTEXT_CACHE_RETRY_AFTER_MS 内命中不再续期。续期成功时归 0。
   */
  renewFailedAt: number;
}

/** 一张登记表对服务端既有条目的启动扫描进度。 */
export type GeminiContextCacheScanState = "idle" | "running" | "done";

/**
 * 一个 scope 在本线程的本地登记表。创建时绑定当下的 Google 客户端，表内全部后台请求
 * 都经这个客户端发出；scope 换表（配置热重载）后，旧表上的在途请求结算时只写旧表。
 */
export interface GeminiContextCacheRegistry {
  readonly client: GoogleGenAI;
  /** 槽键（系统指令指纹）→ 该槽当前引用的服务端条目；至多 scope.maxSlots 槽。 */
  readonly slots: Map<string, GeminiContextCacheSlot>;
  /** 进行中的后台创建，按槽登记；同一槽同时只创建一次，结束（成功或失败）即删除。 */
  readonly creations: Map<string, Promise<void>>;
  /**
   * 槽键 → 最近一次创建失败（瞬时错误）或引用被拒后释放的时刻（epoch 毫秒）；该槽创建成功
   * 或被淘汰时删除。
   */
  readonly failures: Map<string, number>;
  /** 槽键 → 创建被端点以 400 拒绝的内容指纹，同一内容不再创建；该槽创建成功或被淘汰时删除。 */
  readonly rejected: Map<string, string>;
  scan: GeminiContextCacheScanState;
}

/**
 * 一个能力的显式缓存 scope：登记表、后台请求的取消信号与本能力的标识。text 与
 * ad_detect 各一个，displayName 前缀互不相同，启动扫描互不接管。
 */
export interface GeminiContextCacheScope {
  /** 本线程当前的登记表；表不存在时按当下配置的客户端新建。 */
  registry(): GeminiContextCacheRegistry;
  /** 后台扫描、创建、续期与删除使用的取消信号；停机后返回已 abort 的信号。 */
  signal(): AbortSignal;
  /** displayName 前缀，后接「槽指纹:内容指纹」。 */
  readonly displayNamePrefix: string;
  /** 同时登记的槽数上限；超出时删掉最久未用的槽。 */
  readonly maxSlots: number;
  /** 创建条目时按全价上报输入 token 所记的能力。 */
  readonly capability: AiCacheCapability;
  /** 后台请求在日志里的调用名（英文）。 */
  readonly errorLabel: string;
}

/**
 * 一份要缓存的内容及其两段指纹，由 infra/geminiContextCache.ts 的
 * geminiContextCacheContent 一次构造；字段与请求里的同名字段逐字相同。
 */
export interface GeminiContextCacheContent {
  readonly model: string;
  readonly systemInstruction: string;
  readonly tools: Tool[] | undefined;
  readonly toolConfig: Readonly<ToolConfig> | undefined;
  /** 槽键：系统指令的指纹。 */
  readonly slotKey: string;
  /** 内容键：模型、系统指令、工具声明与 toolConfig 的指纹。 */
  readonly contentKey: string;
}
