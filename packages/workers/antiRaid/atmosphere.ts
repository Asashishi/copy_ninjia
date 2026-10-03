import { atmosphereState } from "../../cache/workers/antiRaid/atmosphere";
import { BOT_ATMOSPHERES, DEFAULT_BOT_ATMOSPHERE } from "../../consts/bot";
import { ATMOSPHERE_TEXTS } from "../../consts/atmosphere";
import type { AtmosphereTexts } from "../../types/atmosphere";

/** Worker 按 agentConfig 载荷注入的本进程风格选择固定文案表；业务读取不修改 holder。 */
export function workerAtmosphere(): AtmosphereTexts {
  return ATMOSPHERE_TEXTS[atmosphereState.current ?? BOT_ATMOSPHERES[DEFAULT_BOT_ATMOSPHERE]];
}
