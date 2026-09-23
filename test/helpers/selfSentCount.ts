import { sentMessages } from "../../packages/cache/perThread/selfSentTracker";

/** 断言在窗自发消息总条数；外层 Map 的 size 只表示群数。 */
export function sentMessageCount(): number {
  let count: number = 0;
  for (const byMessage of sentMessages.values()) count += byMessage.size;
  return count;
}
