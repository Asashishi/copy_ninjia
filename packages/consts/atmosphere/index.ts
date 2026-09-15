import * as teasing from "./teasing";
import * as plain from "./plain";
import type { Atmosphere, AtmosphereTexts } from "../../types/atmosphere";

/** 通知文案只读映射；模块初始化一次，选择风格不分配文案表。 */
export const ATMOSPHERE_TEXTS: Readonly<Record<Atmosphere, AtmosphereTexts>> = {
  teasing,
  plain,
};
