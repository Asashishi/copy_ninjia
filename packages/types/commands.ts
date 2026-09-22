import type { Api } from "grammy";
import type { AtmosphereTexts } from "./atmosphere";

/**
 * 目标解析失败时按场景发送的提示文案，由调用方（各命令）定制措辞。
 * 判定见 packages/commands/targetResolution.ts 的 resolveCommandTarget。
 */
export interface CommandTargetMessages {
  /** 既没有可解析的回复目标，也没给目标参数。 */
  readonly missingTarget: string;
  /** 给了非空参数，但它既不是合法 @username、也不是（按开关）合法的用户 id / 会话 id。 */
  readonly invalidUsername: (rawArgument: string) => string;
  /** 给了合法用户名，但当前身份缓存中没有对应条目。 */
  readonly unknownUsername: (rawUsername: string) => string;
  /**
   * 同时给了回复目标与参数，但参数无法解析或两者指向不同身份。
   * 提示需明确目标冲突，本次命令不会继续执行。
   */
  readonly conflictingTarget: (rawArgument: string) => string;
  /** 解析出的目标是机器人自己。 */
  readonly selfTarget: string;
}

/**
 * 权限闸的拒绝文案：拿发起人标签与本群氛围文案拼出整句。
 * 调用方见 packages/commands/commandActor.ts 的 rejectUnlessPermitted。
 */
export type CommandRejectionText = (actorLabel: string, atmosphere: AtmosphereTexts) => string;

/** 以 enable/disable 结尾的命令动作（`/white`、`/block`），见 commands/arguments.ts 的 parseToggleAction。 */
export type ToggleAction = "enable" | "disable";

/**
 * 一条 enable/disable 开关命令的全部对外文案。
 *
 * 六项均必填；状态发生变化与重复执行使用不同回执。
 *
 * 具体文案表见 packages/consts/atmosphere/ 下各风格的 commands.ts，判定见
 * packages/commands/superAdminToggle.ts 的 toggleReplyText。
 */
export interface ToggleCommandTexts {
  /** 权限拒绝提示；入参是发起身份的展示名。 */
  readonly rejection: (mockerLabel: string) => string;
  /** 参数不是 enable/disable 时的用法提示。 */
  readonly usage: string;
  /** 由关变开。 */
  readonly enabled: string;
  /** 由开变关。 */
  readonly disabled: string;
  /** 本来就开着，本次没有改变状态。 */
  readonly alreadyEnabled: string;
  /** 本来就关着，本次没有改变状态。 */
  readonly alreadyDisabled: string;
}

/**
 * 群人设三处对外表现的同步边界（实现在 packages/commands/chatPersonaSync.ts）。
 *
 * 声明成独立类型是为了让 `packages/infra/botAdmin.ts` 能在参数上标注它而不静态
 * 依赖 `commands/`——那条禁令见 docs/cn/04-invariants.md 的 chat runtime teardown 一节。
 * 注入由 `packages/app/registerHandlers.ts` 完成。
 */
export type ChatPersonaSurfaceSync = (api: Api, chatId: number) => Promise<void>;
