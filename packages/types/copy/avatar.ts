import type { CachedUser } from "../chatState";

/**
 * 头像更新的两种目标：偷某个用户/频道的脸，或复原成机器人自己的默认头像。
 *
 * 做成判别联合而不是「user 为空即复原」：两者的失败含义完全不同——偷不到多半
 * 是对方没有公开头像，复原失败则是那个固定链接取不下来，战报与日志都得分开写。
 */
export type AvatarUpdateTarget =
  | { readonly kind: "user"; readonly user: CachedUser }
  | { readonly kind: "default" };

/** 全局头像更新槽中的一份最新目标。 */
export interface AvatarUpdateTask {
  generation: number;
  chatId: number;
  target: AvatarUpdateTarget;
  successText: string;
  failureText: string;
}

export type AvatarUpdateRequest = Omit<AvatarUpdateTask, "generation">;
