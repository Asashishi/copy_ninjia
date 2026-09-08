import type { User } from "grammy/types";
import { WED_DRAW_ATTEMPTS, WED_DRAW_TRANSIENT_LIMIT } from "../../consts/wed";
import { readChatMemberUser } from "../../infra/telegram/actions/membership";
import { readCurrentAvatar } from "../../infra/telegram/avatar/read";
import type { CurrentAvatarResult } from "../../types/telegram";
import type { WedCandidate, WedChat, WedSession } from "../../types/wed";

/**
 * 在有界候选快照中无放回随机抽取；更换时排除当前结果，失败不改写会话。
 *
 * 候选信源只有 memory/wed 的已发言成员集合：抽中后只发一次成员查询取身份，
 * 不判断是否仍在群，也不回写集合——离群成员由退群事件和每日复核清理，见
 * commands/wed/members.ts 与 commands/wed/memberReview.ts。
 * 只有确认没有可用头像才消耗 WED_DRAW_ATTEMPTS；成员查询或头像查询没跑完
 * 不占配额，累计 WED_DRAW_TRANSIENT_LIMIT 次即放弃本轮。
 */
export async function drawWedCandidate(
  session: WedSession,
  chat: WedChat,
  signal: AbortSignal
): Promise<WedCandidate | undefined> {
  const candidates: number[] = [];
  for (const id of chat.members.keys()) {
    if (id !== session.actor.id && id !== session.targetId) candidates.push(id);
  }
  let examined: number = 0;
  let unfinished: number = 0;
  while (examined < WED_DRAW_ATTEMPTS && candidates.length > 0) {
    if (signal.aborted) return undefined;
    const index: number = Math.floor(Math.random() * candidates.length);
    const userId: number = candidates[index]!;
    candidates[index] = candidates[candidates.length - 1]!;
    candidates.pop();
    const user: User | undefined = await readChatMemberUser({ chatId: session.chatId, userId, signal });
    if (user === undefined) {
      if (++unfinished >= WED_DRAW_TRANSIENT_LIMIT) return undefined;
      continue;
    }
    const avatar: CurrentAvatarResult = await readCurrentAvatar(user, signal);
    if (avatar.status === "ok") return signal.aborted ? undefined : { identity: user, photo: avatar.photo };
    if (avatar.status === "transient-failure") {
      if (++unfinished >= WED_DRAW_TRANSIENT_LIMIT) return undefined;
      continue;
    }
    examined++;
  }
  return undefined;
}
