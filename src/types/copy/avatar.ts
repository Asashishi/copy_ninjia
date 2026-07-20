import type { CachedUser } from "../chatState";

/** 全局头像更新槽中的一份最新目标。 */
export interface AvatarUpdateTask {
  generation: number;
  chatId: number;
  target: CachedUser;
  successText: string;
  failureText: string;
}

export type AvatarUpdateRequest = Omit<AvatarUpdateTask, "generation">;
