import { GAG_SPEAK_NOTICE_MESSAGE_INTERVAL } from "../../consts/gag";
import type { GagSession } from "../../types/gag";

/**
 * 给本群所有未到期的活动入口原地计数，并只在命中阈值时返回待换新列表。
 * 常态不分配数组；调用方完成 Telegram 换新后负责把对应计数归零。
 */
export function collectDueGagSpeakNotices(
  sessions: readonly GagSession[],
  now: number
): GagSession[] | null {
  let due: GagSession[] | null = null;
  for (const session of sessions) {
    if (
      session.phase !== "active" ||
      session.expiresAt <= now
    ) continue;
    if (
      session.messagesSinceSpeakNotice <
      GAG_SPEAK_NOTICE_MESSAGE_INTERVAL
    ) session.messagesSinceSpeakNotice++;
    if (
      session.messagesSinceSpeakNotice ===
      GAG_SPEAK_NOTICE_MESSAGE_INTERVAL
    ) {
      due ??= [];
      due.push(session);
    }
  }
  return due;
}
