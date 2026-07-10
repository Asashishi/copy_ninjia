import { join } from "path";
import { v3 as GoogleTranslate } from "@google-cloud/translate";

const GOOGLE_AUTH_FILE_PATH: string = join(import.meta.dir, "..", "g-auth.json");

// Google Cloud Translation - Advanced (v3) 客户端，通过 g-auth.json 里的服务账号
// 密钥完成鉴权——供 copyMode "ja" 使用，用于在复读复制目标的纯文本消息前
// 先将其翻译成日语。
const translateClient: GoogleTranslate.TranslationServiceClient = new GoogleTranslate.TranslationServiceClient({
  keyFilename: GOOGLE_AUTH_FILE_PATH,
});

// v3 请求作用域限定在 "projects/{project}/locations/{location}" 下；project
// 在首次使用时从服务账号凭据中解析得到，并做缓存——因为它在进程生命周期内
// 不会变化。
let translateParent: string | null = null;

async function getTranslateParent(): Promise<string> {
  if (!translateParent) {
    const projectId: string = await translateClient.getProjectId();
    translateParent = `projects/${projectId}/locations/global`;
  }
  return translateParent;
}

/**
 * 通过 Google Cloud Translation API 将文本翻译成日语。
 * 失败时返回 null，让调用方可以退化为发送未翻译的原文，而不是直接丢弃消息。
 * @param text 待翻译的文本。
 */
export async function translateToJapanese(text: string): Promise<string | null> {
  try {
    const parent: string = await getTranslateParent();
    const [response] = await translateClient.translateText({
      parent,
      contents: [text],
      mimeType: "text/plain",
      targetLanguageCode: "ja",
    });
    return response.translations?.[0]?.translatedText ?? null;
  } catch (error: unknown) {
    console.error("Error translating text to Japanese:", error);
    return null;
  }
}
