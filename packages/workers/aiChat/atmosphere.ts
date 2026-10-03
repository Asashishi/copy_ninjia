import { atmosphereState } from "../../cache/workers/aiChat/identity";
import { BOT_ATMOSPHERES, DEFAULT_BOT_ATMOSPHERE } from "../../consts/bot";
import { ATMOSPHERE_TEXTS } from "../../consts/atmosphere";
import type { AtmosphereTexts } from "../../types/atmosphere";

/** AI Worker 按初始化载荷注入的本进程风格选择文案，不增加逐消息同步。 */
export function aiChatAtmosphere(): AtmosphereTexts {
  return ATMOSPHERE_TEXTS[atmosphereState.current ?? BOT_ATMOSPHERES[DEFAULT_BOT_ATMOSPHERE]];
}
