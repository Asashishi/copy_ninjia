/**
 * 部署配置可用性判定的共享类型（判定本身见 packages/config/readiness.ts，
 * 缓存 holder 见 packages/cache/config.ts）。
 */

/** 一份坏掉的部署文件：文件名给人看，诊断给日志看。 */
export interface ConfigFailure {
  /** 相对项目根的路径，如 `config/stickers.json`；直接出现在命令的拒绝文案里。 */
  readonly file: string;
  /** 解析器/文件系统给出的英文诊断，只进日志（见 AGENTS.md 的日志约定）。 */
  readonly reason: string;
}

/** 某个功能所需的全部部署配置是否可用。 */
export type ConfigReadiness =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: ConfigFailure };

/** 单份部署文件的探测项：文件名 + 一次会在坏掉时抛出的加载。 */
export interface DeploymentFileProbe {
  readonly file: string;
  readonly load: () => unknown;
}

/** 判定结论的单例缓存 holder；成功与失败都缓存，见 config/readiness.ts 头注。 */
export interface ConfigReadinessCache {
  current: ConfigReadiness | null;
}
