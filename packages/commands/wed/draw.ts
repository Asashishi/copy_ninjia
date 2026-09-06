import type { User } from "grammy/types";
import { WED_DRAW_ATTEMPTS } from "../../consts/wed";
import { readPresentChatUser } from "../../infra/telegram/actions/membership";
import { readCurrentAvatar } from "../../infra/telegram/avatar/read";
import type { CurrentAvatar } from "../../types/telegram";
import type { WedCandidate, WedChat, WedSession } from "../../types/wed";
import { removeWedMember } from "./persistence";

/** 在有界候选快照中无放回随机抽取；更换时排除当前结果，失败不改写会话。 */
export async function drawWedCandidate(
  session: WedSession,
  chat: WedChat,
  signal: AbortSignal
): Promise<WedCandidate | undefined> {
  const candidates: number[] = [];
  for (const id of chat.members.keys()) {
    if (id !== session.actor.id && id !== session.targetId) candidates.push(id);
  }
  for (let attempt: number = 0; attempt < WED_DRAW_ATTEMPTS && candidates.length > 0; attempt++) {
    if (signal.aborted) return undefined;
    const index: number = Math.floor(Math.random() * candidates.length);
    const userId: number = candidates[index]!;
    candidates[index] = candidates[candidates.length - 1]!;
    candidates.pop();
    const user: User | null | undefined = await readPresentChatUser({ chatId: session.chatId, userId, signal });
    if (user === undefined) return undefined;
    if (user === null || user.is_bot) {
      removeWedMember(session.chatId, userId);
      continue;
    }
    const avatar: CurrentAvatar | undefined = await readCurrentAvatar(user, signal);
    if (avatar !== undefined && !signal.aborted && chat.members.has(userId)) return { identity: user, photo: avatar.photo };
  }
  return undefined;
}
