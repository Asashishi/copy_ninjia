import { ATMOSPHERE_TEXTS } from "../consts/atmosphere";
import { getChatState } from "./storage/stateStore";
import type { AtmosphereTexts } from "../types/atmosphere";

/** 主线程直接读取群状态缓存；没有自定义人设时使用默认雌小鬼文案。 */
export function chatAtmosphere(chatId: number): AtmosphereTexts {
  return getChatState(chatId).aiPersona === undefined
    ? ATMOSPHERE_TEXTS.teasing
    : ATMOSPHERE_TEXTS.plain;
}
