/** 命令处理（src/commands）的调参常量。 */

/** copy 类命令的公共冷却时长（白名单用户豁免，见 handleCopyCommand）。 */
export const COPY_COOLDOWN_MS: number = 5 * 60 * 1000;

// /quiet 静默时长：默认值与上下限（分钟）。
export const QUIET_DEFAULT_MINUTES: number = 3;
export const QUIET_MIN_MINUTES: number = 1;
export const QUIET_MAX_MINUTES: number = 15;
