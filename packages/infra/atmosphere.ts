import { BOT_ATMOSPHERE } from "../config/bot";
import { atmosphereOf } from "../libs/atmosphere";
import { getChatState } from "./storage/stateStore";
import type { AtmosphereTexts } from "../types/atmosphere";

/** 主线程读取群状态缓存；自定义人设优先使用普通文案，其余使用 Bot 配置语气。 */
export function chatAtmosphere(chatId: number): AtmosphereTexts {
  return atmosphereOf(getChatState(chatId), BOT_ATMOSPHERE);
}
