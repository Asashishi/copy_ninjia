import { ATMOSPHERE_TEXTS } from "../consts/atmosphere";
import type { Atmosphere, AtmosphereTexts } from "../types/atmosphere";
import type { ChatState } from "../types/chatState";

/**
 * 按群状态选群通知文案：没有自定义 AI 人设用 Bot 配置文案，配置了人设用普通文案。
 * 纯函数叶子，只读 `aiPersona`、不分配对象，不接触任何线程的缓存；主线程
 * infra/atmosphere.ts 的 chatAtmosphere 与已持有群状态的消息热路径共用。
 */
export function atmosphereOf(chatState: Readonly<ChatState>, defaultAtmosphere: Atmosphere): AtmosphereTexts {
  return chatState.aiPersona === undefined ? ATMOSPHERE_TEXTS[defaultAtmosphere] : ATMOSPHERE_TEXTS.plain;
}
