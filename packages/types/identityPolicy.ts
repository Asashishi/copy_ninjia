/** Telegram 用户或频道随身份策略持久化的展示元数据。 */
export interface TelegramIdentityMetadata {
  readonly firstName: string;
  readonly lastName: string;
  readonly username: string;
}

/** 白名单身份可被逐项授予的权限；字段名与 /permission 参数保持一致。 */
export interface WhitelistPermissions {
  isCanMute: boolean;
  isCanUnMute: boolean;
  isCanGag: boolean;
  isCanViewBotStatus: boolean;
  isCanBlock: boolean;
  isCanUnBlock: boolean;
  isCanWhiteOther: boolean;
  isCanSwitchMood: boolean;
  isCanBypassAdDetection: boolean;
  isCanBypassFloodControl: boolean;
  isCanControllAIPermission: boolean;
  isCanConfigAiPrompt: boolean;
  isCanClearContext: boolean;
  isCanControllAdDetectPermission: boolean;
  isCanControllFloodControlPermission: boolean;
  isCanControllTranslatePermission: boolean;
  isCanControllAntiRaidPermission: boolean;
  isCanControllQaPermission: boolean;
}

/** /permission 接受的权限键。 */
export type WhitelistPermissionKey = keyof WhitelistPermissions;

/** 白名单表 data 列的严格 JSON 结构。 */
export interface WhitelistEntryData {
  readonly permissions: Readonly<WhitelistPermissions>;
  readonly meta: Readonly<TelegramIdentityMetadata>;
}

/** 黑名单表 data 列的严格 JSON 结构。 */
export interface BlocklistEntryData {
  /** 东京时间字符串「YYYY/MM/DD HH:mm:ss」。 */
  readonly blockedAt: string;
  readonly meta: Readonly<TelegramIdentityMetadata>;
  /**
   * 连续被 Telegram 以 PARTICIPANT_ID_INVALID 拒绝的群级补扫处置次数；缺省表示 0，
   * 存在时为 1 到 BLOCKLIST_PARTICIPANT_INVALID_LIMIT - 1。
   */
  readonly participantInvalidCount?: number;
}

/** 身份策略写入的业务表名；每张表独立计算批量提交上限。 */
export type IdentityPolicyTable = "whitelist" | "blocklist";
