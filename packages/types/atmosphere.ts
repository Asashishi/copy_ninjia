import type * as TeasingTexts from "../consts/atmosphere/teasing";

/** 群通知的两种风格；自定义 AI 人设对应普通风格。 */
export type Atmosphere = "teasing" | "plain";

/** 两套文案必须提供相同的键和格式化函数签名。 */
export type AtmosphereTexts = typeof TeasingTexts;
