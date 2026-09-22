import type * as TeasingTexts from "../consts/atmosphere/teasing";

/** Bot 部署配置中的通知风格枚举。 */
export type BotAtmosphere = "mesugaki" | "normal";

/** 通知文案表的内部风格键；由 Bot 配置映射，自定义 AI 人设优先使用 plain。 */
export type Atmosphere = "teasing" | "plain";

/** 两套文案必须提供相同的键和格式化函数签名。 */
export type AtmosphereTexts = typeof TeasingTexts;
