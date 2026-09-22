import type { Atmosphere, BotAtmosphere } from "../types/atmosphere";

/** Bot 配置缺省通知风格；自定义群人设仍优先使用普通文案。 */
export const DEFAULT_BOT_ATMOSPHERE: BotAtmosphere = "mesugaki";

/** 部署枚举到既有通知表的只读映射，初始化时转换一次。 */
export const BOT_ATMOSPHERES: Readonly<Record<BotAtmosphere, Atmosphere>> = {
  mesugaki: "teasing",
  normal: "plain",
};

/** Bot 配置冷迁移的源文件名；运行时只用于拒绝未迁移目录，不读取旧内容。 */
export const LEGACY_BOT_CONFIG_NAME: string = "telegram.json";
