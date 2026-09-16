import { chatPersonas } from "../../cache/workers/aiChat/persona";
import { ATMOSPHERE_TEXTS } from "../../consts/atmosphere";
import type { AtmosphereTexts } from "../../types/atmosphere";

/** AI Worker 复用既有人设镜像选择通知文案，不新增缓存或线程消息。 */
export function aiChatAtmosphere(chatId: number): AtmosphereTexts {
  return chatPersonas.has(chatId) ? ATMOSPHERE_TEXTS.plain : ATMOSPHERE_TEXTS.teasing;
}
