import type { CachedUser } from "../chatState";

/** 头像更新目标：用户或频道的公开头像，或机器人的默认头像。 */
export type AvatarUpdateTarget =
  | { readonly kind: "user"; readonly user: CachedUser }
  | { readonly kind: "default" };

/** 头像回执所属的命令；发送时据此选择当前群氛围中的文案。 */
export type AvatarNoticeSource = "copy" | "icon";

/** 全局头像更新槽中的最新目标与回执来源；渲染时机见 docs/cn/04-invariants.md。 */
export interface AvatarUpdateTask {
  generation: number;
  chatId: number;
  target: AvatarUpdateTarget;
  source: AvatarNoticeSource;
}

export type AvatarUpdateRequest = Omit<AvatarUpdateTask, "generation">;
