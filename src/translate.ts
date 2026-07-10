import { join } from "path";
import { v3 as GoogleTranslate } from "@google-cloud/translate";

const GOOGLE_AUTH_FILE_PATH: string = join(import.meta.dir, "..", "g-auth.json");

// Google Cloud Translation - Advanced (v3) client, authenticated via the
// service account key at g-auth.json — used by copyMode "ja" to translate the
// copy target's plain-text messages into Japanese before echoing them back.
const translateClient: GoogleTranslate.TranslationServiceClient = new GoogleTranslate.TranslationServiceClient({
  keyFilename: GOOGLE_AUTH_FILE_PATH,
});

// v3 requests are scoped to "projects/{project}/locations/{location}"; the
// project is derived from the service account credentials on first use and
// cached since it never changes for the lifetime of the process.
let translateParent: string | null = null;

async function getTranslateParent(): Promise<string> {
  if (!translateParent) {
    const projectId: string = await translateClient.getProjectId();
    translateParent = `projects/${projectId}/locations/global`;
  }
  return translateParent;
}

/**
 * Translates text into Japanese via the Google Cloud Translation API.
 * Returns null on failure so the caller can fall back to an untranslated copy
 * instead of dropping the message entirely.
 * @param text The text to translate.
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
