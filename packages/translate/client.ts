import { TRANSLATE_LANGUAGE_CODES, TRANSLATE_REGIONAL_MODEL } from "../consts/translate";
import type { TranslateLanguage } from "../types/translate";
import { logger } from "../infra/logger";
import type { v3 as GoogleTranslate, protos } from "@google-cloud/translate";
import { googleServiceAccountKey, translateParentCache, translateRuntime } from "../cache/main/translate";
import type { GoogleServiceAccountKey } from "../types/config";
import { TRANSLATE_REQUEST_TIMEOUT_MS } from "../consts/lifecycle";
import { withTimeout } from "../libs/withTimeout";
import { assertTimeoutMs, settleWithinBudget, trackInflight } from "../libs/inflight";
import type { FlushResult } from "../types/lifecycle";

// Google Cloud Translation - Advanced (v3) 客户端使用启动时发布的凭据快照。

/** TranslationServiceClient 构造器的选项形状。 */
interface TranslateClientParams {
  /** 启动总闸严格解析的完整服务账号快照。 */
  credentials: GoogleServiceAccountKey;
  /**
   * SDK 真实的 `ClientOptions`（来自传递依赖 google-gax）带索引签名，本接口以索引签名
   * 满足构造器形参的逆变要求；类型不直接引自 google-gax（传递依赖，不在本仓 package.json 里）。
   */
  [option: string]: string | number | object | undefined;
}

/**
 * 动态 import 回来的 SDK 里，本模块唯一用到的那部分：只声明 TranslationServiceClient
 * 构造器，SDK 真实签名一旦漂移就在编译期暴露。
 */
interface TranslateSdkV3 {
  TranslationServiceClient: new (options: TranslateClientParams) => GoogleTranslate.TranslationServiceClient;
}

/** 由应用生命周期显式开启；仍不会在没有真实请求时构造 gRPC 客户端。 */
export function initTranslate(): void {
  translateRuntime.accepting = true;
}

/** 同步关闭新工作入口，已开始的请求交给 drainTranslate 等待。 */
export function quiesceTranslate(): void {
  translateRuntime.accepting = false;
}

/** 世代闸：owner 已被 close/重开时，在途请求必须就地失败而不是继续用旧世代。 */
function ensureTranslateGeneration(expectedGeneration: number): void {
  if (expectedGeneration !== translateRuntime.generation) {
    throw new Error("Google Translation owner was closed while the request was in flight");
  }
}

/**
 * gRPC 客户端惰性构造：首次真实翻译时才构造，模块导入无副作用（客户端构造会注册退避 timer）。
 *
 * **SDK 本身也是动态 import 的**，不能写成顶层 `import`：本模块经翻译消息处理与
 * lifecycleDependencies 挂在启动路径上，只有真实请求翻译时才加载 gRPC 模块图。
 * 类型侧仍是顶层 `import type`。
 *
 * 生命周期钩子（initTranslate/quiesceTranslate/closeTranslate/drainTranslate）
 * 只碰 translateRuntime 上的标志与已有实例，不需要 SDK。
 *
 * `await import(...)` 期间 `closeTranslate` 可能把 client 置空并推进 generation；
 * await 之后先复核 generation，不属于当前 owner 就直接抛，不构造客户端。
 */
async function getTranslateClient(expectedGeneration: number): Promise<GoogleTranslate.TranslationServiceClient> {
  if (translateRuntime.client !== null) return translateRuntime.client;
  const credentials: GoogleServiceAccountKey | null = googleServiceAccountKey.current;
  if (credentials === null) throw new Error("Google Translation credentials were not configured at startup");
  const { v3 }: { v3: TranslateSdkV3 } = await import("@google-cloud/translate");
  ensureTranslateGeneration(expectedGeneration);
  // 并发首次翻译可能都走到这里；`??=` 保证只有先到的那个实例被留下。
  translateRuntime.client ??= new v3.TranslationServiceClient({
    credentials,
  });
  return translateRuntime.client;
}

// v3 请求作用域限定在 "projects/{project}/locations/{location}" 下；project
// 解析与缓存见下方（缓存见 cache/main/translate.ts）。
async function getTranslateParent(expectedGeneration: number): Promise<string> {
  ensureTranslateGeneration(expectedGeneration);
  if (!translateParentCache.parent) {
    const projectId: string = await withTimeout(
      (await getTranslateClient(expectedGeneration)).getProjectId(),
      TRANSLATE_REQUEST_TIMEOUT_MS,
      "Google Translation project lookup"
    );
    // drain 超时后 close 可能早于 getProjectId 的迟到回执；不允许旧
    // owner 重写 parent，更不允许它在下一步重新惰性创建客户端。
    ensureTranslateGeneration(expectedGeneration);
    translateParentCache.parent = `projects/${projectId}/locations/global`;
  }
  return translateParentCache.parent;
}

/**
 * 通过 Google Cloud Translation API 将文本翻译成指定语言。
 * 失败时返回 null，调用方整条不发送。
 * @param text 待翻译的文本。
 */
async function runTranslation(text: string, language: TranslateLanguage, expectedGeneration: number): Promise<string | null> {
  try {
    const parent: string = await getTranslateParent(expectedGeneration);
    ensureTranslateGeneration(expectedGeneration);
    // translateText 是重载签名，ReturnType 只会取到回调那一版，因此直接写出
    // 元组首项的 proto 响应类型。
    const [response]: [
      protos.google.cloud.translation.v3.ITranslateTextResponse,
      protos.google.cloud.translation.v3.ITranslateTextRequest | undefined,
      Record<string, never> | undefined
    ] = await (await getTranslateClient(expectedGeneration)).translateText({
      parent,
      contents: [text],
      mimeType: "text/plain",
      targetLanguageCode: TRANSLATE_LANGUAGE_CODES[language],
      model: language === "en" ? `${parent}/models/${TRANSLATE_REGIONAL_MODEL}` : undefined,
    }, { timeout: TRANSLATE_REQUEST_TIMEOUT_MS });
    // 空字符串和 null/undefined 同样按失败返回 null。
    const translated: string | null | undefined = response.translations?.[0]?.translatedText;
    return translated ? translated : null;
  } catch (error: unknown) {
    logger.error("Error translating text:", error);
    return null;
  }
}

export function translateText(text: string, language: TranslateLanguage): Promise<string | null> {
  if (!translateRuntime.accepting) return Promise.resolve(null);
  return trackInflight(
    translateRuntime.tasks,
    runTranslation(text, language, translateRuntime.generation)
  );
}

/** 等待所有已接收翻译结束；超时只报告，closeTranslate 仍会尝试关闭通道。 */
export async function drainTranslate(timeoutMs: number): Promise<FlushResult> {
  assertTimeoutMs(timeoutMs, "translate drain timeout");
  if (translateRuntime.tasks.size === 0) return "flushed";
  if (timeoutMs === 0) return "timedOut";

  const drained: boolean = await settleWithinBudget(translateRuntime.tasks, timeoutMs);
  return drained ? "flushed" : "timedOut";
}

/** 释放 gRPC 客户端与 project parent；重新 init 后会构造全新客户端。 */
export async function closeTranslate(timeoutMs: number = TRANSLATE_REQUEST_TIMEOUT_MS): Promise<FlushResult> {
  assertTimeoutMs(timeoutMs, "translate close timeout");
  translateRuntime.accepting = false;
  translateRuntime.generation += 1;
  const client: GoogleTranslate.TranslationServiceClient | null = translateRuntime.client;
  translateRuntime.client = null;
  translateParentCache.parent = null;
  if (client === null) return "flushed";
  try {
    await withTimeout(
      Promise.resolve(client.close()),
      timeoutMs,
      "Google Translation client close"
    );
    return "flushed";
  } catch (error: unknown) {
    logger.error("Error closing Google Translation client:", error);
    return "failed";
  }
}
