import type { CachedUser } from "../chatState";

/** 头像更新目标：用户或频道的公开头像，或机器人的默认头像。 */
export type AvatarUpdateTarget =
  | { readonly kind: "user"; readonly user: CachedUser }
  | { readonly kind: "default" };

/** 头像回执所属的命令；发送时据此选择本进程氛围中的文案。 */
export type AvatarNoticeSource = "copy" | "icon";

/** 全局头像更新槽中的最新目标与回执来源；渲染时机见 docs/cn/04-invariants.md。 */
export interface AvatarUpdateTask {
  generation: number;
  chatId: number;
  target: AvatarUpdateTarget;
  source: AvatarNoticeSource;
  /** 回执落点：提交时所属 update 触发消息的论坛话题；不在话题里时为 undefined。 */
  messageThreadId: number | undefined;
  /** 为 true 时只换头像、不发回执；群 teardown 复原默认头像时使用。 */
  silent: boolean;
}

/** 提交给 queueAvatarUpdate 的请求；`silent` 缺省为 false。 */
export interface AvatarUpdateRequest {
  readonly chatId: number;
  readonly target: AvatarUpdateTarget;
  readonly source: AvatarNoticeSource;
  readonly silent?: boolean;
}
