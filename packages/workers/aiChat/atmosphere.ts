import { defaultAtmosphereState } from "../../cache/workers/aiChat/identity";
import { BOT_ATMOSPHERES, DEFAULT_BOT_ATMOSPHERE } from "../../consts/bot";
import { chatPersonas } from "../../cache/workers/aiChat/persona";
import { ATMOSPHERE_TEXTS } from "../../consts/atmosphere";
import type { AtmosphereTexts } from "../../types/atmosphere";

/** AI Worker 复用人设镜像和初始化风格选择文案，不增加逐消息同步。 */
export function aiChatAtmosphere(chatId: number): AtmosphereTexts {
  return chatPersonas.has(chatId) ? ATMOSPHERE_TEXTS.plain : ATMOSPHERE_TEXTS[defaultAtmosphereState.current ?? BOT_ATMOSPHERES[DEFAULT_BOT_ATMOSPHERE]];
}
