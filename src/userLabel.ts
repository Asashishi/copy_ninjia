import type { CachedUser } from "./types";

/**
 * Human-readable label for a cached user/channel in reply texts. Falls back to
 * first_name/title when the target has no public @username — e.g. one
 * resolved by replying to their message instead of via the username cache.
 * @param user The user/channel to label.
 */
export function formatUserLabel(user: CachedUser): string {
  if (user.username) return `@${user.username}`;
  if (user.isChannel) return user.title ?? "这个频道";
  return user.first_name ?? "这个杂鱼";
}
