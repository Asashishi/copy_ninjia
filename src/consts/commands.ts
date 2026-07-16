/** 命令处理（src/commands）的调参常量。 */

/** copy 类命令的公共冷却时长（白名单用户豁免，见 commands/copyShared.ts 的 claimCopyCooldownOrReject）。 */
export const COPY_COOLDOWN_MS: number = 5 * 60 * 1000;

/**
 * 从命令参数里解析裸 @username（如 "/copy @foo" 的 "@foo"）的正则，
 * 见 commands/targetResolution.ts 的 resolveCommandTarget。
 */
export const USERNAME_ARG_PATTERN: RegExp = /^@?([a-zA-Z0-9_]+)/;

// /quiet 静默时长：默认值与上下限（分钟）。
export const QUIET_DEFAULT_MINUTES: number = 3;
export const QUIET_MIN_MINUTES: number = 1;
export const QUIET_MAX_MINUTES: number = 15;
