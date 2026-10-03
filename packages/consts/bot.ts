import type { Atmosphere, BotAtmosphere } from "../types/atmosphere";

/** Bot 未配置风格且使用内置人设时的默认通知风格；启动规则见 docs/cn/04-invariants.md。 */
export const DEFAULT_BOT_ATMOSPHERE: BotAtmosphere = "mesugaki";

/** Bot 默认 IANA 时区；仅在 bot.json 未配置 time_zone 时使用，不继承宿主机时区。 */
export const DEFAULT_BOT_TIME_ZONE: string = "Asia/Tokyo";

/** 部署枚举到 Atmosphere 通知表的只读映射，初始化时转换一次。 */
export const BOT_ATMOSPHERES: Readonly<Record<BotAtmosphere, Atmosphere>> = {
  mesugaki: "teasing",
  normal: "plain",
};

/** Bot 配置冷迁移的源文件名；config/layout.ts 只用于拒绝配置根顶层的未迁移入口，不读取旧内容。 */
export const LEGACY_BOT_CONFIG_NAME: string = "telegram.json";
