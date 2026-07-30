/** 白名单身份可被逐项授予的权限。字段名与 /permission 命令参数保持一致。 */
export interface WhitelistPermissions {
  isCanMute: boolean;
  isCanUnMute: boolean;
  isCanBlock: boolean;
  isCanUnBlock: boolean;
  isCanUnBlockAll: boolean;
  isCanSwitchMood: boolean;
  isCanBypassAdDetection: boolean;
  isCanControllAIPermission: boolean;
  isCanControllAdDetectPermission: boolean;
  isCanControllJATranslatePermission: boolean;
}

/** /permission 接受的权限键。 */
export type WhitelistPermissionKey = keyof WhitelistPermissions;

/** 进程内已严格校验并补齐默认值的白名单配置。 */
export type WhitelistConfig = ReadonlyMap<number, Readonly<WhitelistPermissions>>;

/** /permission 持久化一项授权时的入参。 */
export interface SetWhitelistPermissionParams {
  id: number;
  key: WhitelistPermissionKey;
  value: boolean;
}

/** /permission 持久化的结果；changed=false 表示配置原本就是该值。 */
export interface SetWhitelistPermissionResult {
  changed: boolean;
  permissions: Readonly<WhitelistPermissions>;
}

/** /white 新增或删除白名单身份时的入参。 */
export interface SetWhitelistMembershipParams {
  id: number;
  enabled: boolean;
}

/**
 * /white 持久化白名单成员关系的结果。删除后 permissions 为 undefined；
 * 重复 enable 返回原有权限，绝不把已经单独授权的字段重置成默认值。
 */
export interface SetWhitelistMembershipResult {
  changed: boolean;
  permissions: Readonly<WhitelistPermissions> | undefined;
}
