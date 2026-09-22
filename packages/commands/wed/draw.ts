import type { User } from "grammy/types";
import { WED_DRAW_ATTEMPTS, WED_DRAW_TRANSIENT_LIMIT } from "../../consts/wed";
import { readCurrentAvatar } from "../../infra/telegram/avatar/read";
import type { AvatarIdentity, CurrentAvatarResult } from "../../types/telegram";
import type { WedCandidate, WedChat, WedSession } from "../../types/wed";

/**
 * getChat 以私聊资料核实过的候选转成图注与提及实体要用的 User；其它身份返回 undefined。
 * 候选 ID 只来自以个人身份发言的非机器人用户（commands/wed/members.ts），因此 is_bot 恒为 false。
 */
function privateChatUser(identity: AvatarIdentity): User | undefined {
  if (!("type" in identity) || identity.type !== "private") return undefined;
  return {
    id: identity.id,
    is_bot: false,
    first_name: identity.first_name,
    last_name: identity.last_name,
    username: identity.username,
  };
}

/**
 * 在有界候选快照中无放回随机抽取；更换时排除当前结果，失败不改写会话。
 *
 * 候选信源只有 memory/wed 的已发言成员 ID 集合：抽中后只按 ID 读当前头像，身份（图注和公开
 * 头像兜底都要用）取自同一次 getChat 返回的私聊资料，不发 getChatMember，因此不要求机器人是
 * 群管理员。不判断是否仍在群，也不回写集合——离群成员由退群事件和每日复核清理，见
 * commands/wed/members.ts 与 commands/wed/memberReview.ts；机器人不是群管理员时两者都
 * 不完整，已离群的人仍会被抽中，这是既定行为，见 docs/cn/04-invariants.md。
 * 只有确认没有可用头像（含 getChat 核实出来不是私聊用户）才消耗 WED_DRAW_ATTEMPTS；
 * 查询没跑完不占配额，累计 WED_DRAW_TRANSIENT_LIMIT 次即放弃本轮。
 * signal 是**抽取阶段**自己的预算，与投递阶段各算各的，见 commands/wed.ts 的
 * operationSignal。预算耗尽、群 teardown 和停机取消同样返回 undefined，调用方按
 * signal 的取消来源决定回执还是静默。
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
    const avatar: CurrentAvatarResult = await readCurrentAvatar(userId, signal);
    if (avatar.status === "ok") {
      const identity: User | undefined = privateChatUser(avatar.identity);
      if (identity !== undefined) return signal.aborted ? undefined : { identity, photo: avatar.photo };
    } else if (avatar.status === "transient-failure") {
      if (++unfinished >= WED_DRAW_TRANSIENT_LIMIT) return undefined;
      continue;
    }
    examined++;
  }
  return undefined;
}
