import {
  defaultAtmosphereState,
  plainAtmosphereChats,
} from "../../cache/workers/antiRaid/atmosphere";
import { BOT_ATMOSPHERES, DEFAULT_BOT_ATMOSPHERE } from "../../consts/bot";
import { ATMOSPHERE_TEXTS } from "../../consts/atmosphere";
import type { AtmosphereTexts } from "../../types/atmosphere";

/** Worker 本地选择固定文案表；业务读取不修改镜像。 */
export function workerAtmosphere(chatId: number): AtmosphereTexts {
  return plainAtmosphereChats.has(chatId) ? ATMOSPHERE_TEXTS.plain : ATMOSPHERE_TEXTS[defaultAtmosphereState.current ?? BOT_ATMOSPHERES[DEFAULT_BOT_ATMOSPHERE]];
}

/** 仅接收 main 的人设变更消息；恢复默认时删除条目。 */
export function applyWorkerAtmosphere(chatId: number, plain: boolean): void {
  if (plain) plainAtmosphereChats.add(chatId);
  else plainAtmosphereChats.delete(chatId);
}
