import { atmosphereState } from "../../cache/workers/aiChat/identity";
import { BOT_ATMOSPHERES, DEFAULT_BOT_ATMOSPHERE } from "../../consts/bot";
import { ATMOSPHERE_TEXTS } from "../../consts/atmosphere";
import type { AtmosphereTexts } from "../../types/atmosphere";

/** 按 init 载荷注入的风格（atmosphereState）选择文案；未注入时取默认风格。 */
export function aiChatAtmosphere(): AtmosphereTexts {
  return ATMOSPHERE_TEXTS[atmosphereState.current ?? BOT_ATMOSPHERES[DEFAULT_BOT_ATMOSPHERE]];
}
