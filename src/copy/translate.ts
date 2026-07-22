import { logger } from "../infra/logger";
import { v3 as GoogleTranslate } from "@google-cloud/translate";
import { GOOGLE_AUTH_FILE_PATH } from "../consts/paths";
import { translateParentCache } from "../cache/translate";
import { TRANSLATE_REQUEST_TIMEOUT_MS, type FlushResult } from "../consts/lifecycle";

// Google Cloud Translation - Advanced (v3) 客户端，通过 g-auth.json 里的服务账号
// 密钥完成鉴权——供 copyMode "ja" 使用，用于在复读复制目标的纯文本消息前
// 先将其翻译成日语。
let translateClient: GoogleTranslate.TranslationServiceClient | null = null;
let acceptingTranslations: boolean = false;
let translateGeneration: number = 0;
const translateTasks: Set<Promise<string | null>> = new Set();

/** 由应用生命周期显式开启；仍不会在没有真实请求时构造 gRPC 客户端。 */
export function initTranslate(): void {
  acceptingTranslations = true;
}

/** 同步关闭新工作入口，已开始的请求交给 drainTranslate 等待。 */
export function quiesceTranslate(): void {
  acceptingTranslations = false;
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    task,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
      timer.unref();
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** gRPC 客户端构造会注册退避 timer；延迟到首次真实翻译，保持模块导入无副作用。 */
function getTranslateClient(): GoogleTranslate.TranslationServiceClient {
  translateClient ??= new GoogleTranslate.TranslationServiceClient({
    keyFilename: GOOGLE_AUTH_FILE_PATH,
  });
  return translateClient;
}

// v3 请求作用域限定在 "projects/{project}/locations/{location}" 下；project
// 解析与缓存见 getTranslateParent（缓存原因见 cache/translate.ts）。
function ensureTranslateGeneration(expectedGeneration: number): void {
  if (expectedGeneration !== translateGeneration) {
    throw new Error("Google Translation owner was closed while the request was in flight");
  }
}

async function getTranslateParent(expectedGeneration: number): Promise<string> {
  ensureTranslateGeneration(expectedGeneration);
  if (!translateParentCache.parent) {
    const projectId: string = await withTimeout(
      getTranslateClient().getProjectId(),
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
    const [response] = await getTranslateClient().translateText({
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
  if (!acceptingTranslations) return Promise.resolve(null);
  const task: Promise<string | null> = runTranslation(text, translateGeneration);
  translateTasks.add(task);
  void task.finally(() => { translateTasks.delete(task); });
  return task;
}

/** 等待所有已接收翻译结束；超时只报告，closeTranslate 仍会尝试关闭通道。 */
export async function drainTranslate(timeoutMs: number): Promise<FlushResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("translate drain timeout must be a non-negative finite number");
  }
  if (translateTasks.size === 0) return "flushed";
  if (timeoutMs === 0) return "timedOut";

  let timer: ReturnType<typeof setTimeout> | undefined;
  const drained: boolean = await Promise.race([
    Promise.allSettled([...translateTasks]).then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
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
  acceptingTranslations = false;
  translateGeneration += 1;
  const client: GoogleTranslate.TranslationServiceClient | null = translateClient;
  translateClient = null;
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
