import { logger } from "../infra/logger";
import type { v3 as GoogleTranslate, protos } from "@google-cloud/translate";
import { GOOGLE_AUTH_FILE_PATH } from "../consts/paths";
import { translateParentCache, translateRuntime } from "../cache/main/translate";
import { TRANSLATE_REQUEST_TIMEOUT_MS } from "../consts/lifecycle";
import { withTimeout } from "../libs/withTimeout";
import type { FlushResult } from "../types/lifecycle";

// Google Cloud Translation - Advanced (v3) 客户端，通过 g-auth.json 里的服务账号
// 密钥完成鉴权——供 copyMode "ja" 使用，用于在复读复制目标的纯文本消息前
// 先将其翻译成日语。

/**
 * 动态 import 回来的 SDK 里，本模块唯一用到的那部分。
 *
 * 只声明用得上的构造器，而不是给整个模块写类型：`typeof import(...)` 标注被
 * lint 禁止，顶层的 `import type { v3 as GoogleTranslate }` 又只是命名空间
 * **类型**别名、取不到值侧类型。写成结构类型既满足显式标注，也让 SDK 真实签名
 * 一旦漂移就在编译期暴露。
 */
interface TranslateClientParams {
  /** 服务账号密钥文件路径；见 consts/paths.ts 的 GOOGLE_AUTH_FILE_PATH。 */
  keyFilename: string;
  /**
   * SDK 真实的 `ClientOptions`（来自传递依赖 google-gax）带索引签名，少了它
   * 本接口就不满足构造器形参的逆变要求。不从 google-gax 直接引类型：那是传递
   * 依赖、不在本仓 package.json 里，钉着它等于给自己埋一颗版本地雷。
   */
  [option: string]: string | number | object | undefined;
}

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
 * gRPC 客户端构造会注册退避 timer；延迟到首次真实翻译，保持模块导入无副作用。
 *
 * **SDK 本身也是动态 import 的**，不能写成顶层 `import`。`@google-cloud/translate`
 * 那张 gRPC 模块图极重：实测静态导入它要 383~447 ms、常驻 +9.72 MB 堆、+83547 个
 * 对象，而主线程整图一共才 570~734 ms / +11.35 MB / +97529 个对象——也就是说约
 * 86% 的启动堆和对象数，全压在一个 `/ja_copy` 上。本模块又经 copyModes 与
 * lifecycleDependencies 挂在启动路径上，静态导入等于每次重启都替所有部署方付这笔
 * 账，哪怕它从没开过日语复读。
 *
 * 生命周期钩子（initTranslate/quiesceTranslate/closeTranslate/drainTranslate）
 * 只碰 translateRuntime 上的标志与已有实例，都不需要 SDK，因此这条惰性边界
 * 收在这里最干净。类型侧仍是顶层 `import type`，编译期擦除、零运行时成本。
 *
 * **改成 async 之后必须重新对代**：`await import(...)` 制造了一个原先同步版本
 * 不存在的交错窗口，`closeTranslate` 可能正好在这期间把 client 置空并推进
 * generation。此时若照旧构造并写回，就会留下一个**永远不会被 close 的 gRPC
 * 客户端**（close 已经拿着 null 走完了）——一条随每次停机泄漏一个通道的路径。
 * 因此 await 之后先复核 generation，不属于当前 owner 就直接抛，绝不构造。
 */
async function getTranslateClient(expectedGeneration: number): Promise<GoogleTranslate.TranslationServiceClient> {
  if (translateRuntime.client !== null) return translateRuntime.client;
  const { v3 }: { v3: TranslateSdkV3 } = await import("@google-cloud/translate");
  ensureTranslateGeneration(expectedGeneration);
  // 并发首次翻译可能都走到这里；`??=` 保证只有先到的那个实例被留下，
  // 与原先同步版本的单例语义一致。
  translateRuntime.client ??= new v3.TranslationServiceClient({
    keyFilename: GOOGLE_AUTH_FILE_PATH,
  });
  return translateRuntime.client;
}

// v3 请求作用域限定在 "projects/{project}/locations/{location}" 下；project
// 解析与缓存见下方（缓存原因见 cache/main/translate.ts）。
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
 * 通过 Google Cloud Translation API 将文本翻译成日语。
 * 失败时返回 null，让调用方可以退化为发送未翻译的原文，而不是直接丢弃消息。
 * @param text 待翻译的文本。
 */
async function runTranslation(text: string, expectedGeneration: number): Promise<string | null> {
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
      targetLanguageCode: "ja",
    }, { timeout: TRANSLATE_REQUEST_TIMEOUT_MS });
    // 空字符串和 null/undefined 同等对待：调用方靠 null 判断"翻译失败，退化
    // 发原文"，空字符串若被当成"翻译成功"会尝试发一条空消息，被 Telegram
    // 拒绝，消息就此静默丢失，而不是像真正失败时那样原样转发。
    const translated: string | null | undefined = response.translations?.[0]?.translatedText;
    return translated ? translated : null;
  } catch (error: unknown) {
    logger.error("Error translating text to Japanese:", error);
    return null;
  }
}

export function translateToJapanese(text: string): Promise<string | null> {
  if (!translateRuntime.accepting) return Promise.resolve(null);
  const task: Promise<string | null> = runTranslation(text, translateRuntime.generation);
  translateRuntime.tasks.add(task);
  void task.finally((): void => { translateRuntime.tasks.delete(task); });
  return task;
}

/** 等待所有已接收翻译结束；超时只报告，closeTranslate 仍会尝试关闭通道。 */
export async function drainTranslate(timeoutMs: number): Promise<FlushResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("translate drain timeout must be a non-negative finite number");
  }
  if (translateRuntime.tasks.size === 0) return "flushed";
  if (timeoutMs === 0) return "timedOut";

  let timer: ReturnType<typeof setTimeout> | undefined;
  const drained: boolean = await Promise.race([
    Promise.allSettled([...translateRuntime.tasks]).then((): boolean => true),
    new Promise<boolean>((resolve: (value: boolean | PromiseLike<boolean>) => void): void => {
      timer = setTimeout((): void => resolve(false), timeoutMs);
      timer.unref();
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return drained ? "flushed" : "timedOut";
}

/** 释放 gRPC 客户端与 project parent；重新 init 后会构造全新客户端。 */
export async function closeTranslate(timeoutMs: number = TRANSLATE_REQUEST_TIMEOUT_MS): Promise<FlushResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("translate close timeout must be a non-negative finite number");
  }
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
