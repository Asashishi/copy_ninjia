import type { User } from "grammy/types";
import { wedRuntime } from "../../cache/main/wed";
import { wedMemberReview } from "../../cache/main/wedMemberReview";
import { wedMemberStates } from "../../cache/main/wedMembers";
import {
  WED_MEMBER_REVIEW_INTERVAL_MS,
  WED_OPERATION_TIMEOUT_MS,
} from "../../consts/wed";
import { trackBackgroundTask } from "../../infra/backgroundTasks";
import { onMidnightMaintenance } from "../../infra/diskIO/observers";
import { readPresentChatUser } from "../../infra/telegram/actions/membership";
import { monotonicNow } from "../../libs/monotonicDeadline";
import { sleep } from "../../libs/sleep";
import type { MidnightMaintenanceReply } from "../../types/diskIO/replies";
import type { WedMemberReview, WedRuntime } from "../../types/wed";
import { removeWedMember } from "./persistence";

/** 逐群快照，串行查询并限制全局起始频率；只删除确认离群且没有新在群观察的成员。 */
async function reviewWedMembers(review: WedMemberReview): Promise<void> {
  let nextCheckAt: number = 0;
  try {
    for (const [chatId, state] of wedMemberStates) {
      if (review.controller.signal.aborted) return;
      const members: readonly number[] = [...state.members];
      for (const userId of members) {
        if (review.controller.signal.aborted || wedMemberStates.get(chatId) !== state) return;
        if (!state.members.has(userId)) continue;
        let delay: number = nextCheckAt - monotonicNow();
        while (delay > 0) {
          await sleep(Math.ceil(delay), review.controller.signal);
          delay = nextCheckAt - monotonicNow();
        }
        if (review.controller.signal.aborted || wedMemberStates.get(chatId) !== state) return;
        if (!state.members.has(userId)) continue;
        review.chatId = chatId;
        review.userId = userId;
        review.observed = false;
        nextCheckAt = monotonicNow() + WED_MEMBER_REVIEW_INTERVAL_MS;
        const signal: AbortSignal = AbortSignal.any([
          review.controller.signal,
          AbortSignal.timeout(WED_OPERATION_TIMEOUT_MS),
        ]);
        const user: User | null | undefined = await readPresentChatUser({ chatId, userId, signal });
        if (wedMemberStates.get(chatId) !== state) return;
        if (user === null && !signal.aborted && !review.observed) {
          removeWedMember(chatId, userId);
        }
        review.chatId = null;
        review.userId = null;
        review.observed = false;
      }
    }
  } finally {
    review.chatId = null;
    review.userId = null;
    review.observed = false;
  }
}

/** 接纳统一午夜通知；启动未就绪时暂存，整轮运行中不叠加任务。 */
function requestWedMemberReview(day: string): void {
  const runtime: WedRuntime | null = wedRuntime.current;
  const review: WedMemberReview | null = wedMemberReview.current;
  if (runtime === null || !runtime.accepting || review === null) return;
  if (!review.ready) {
    review.pendingDay = day;
    return;
  }
  if (review.running || review.lastDay === day) return;
  review.lastDay = day;
  review.running = true;
  const task: Promise<void> = reviewWedMembers(review).catch((error: unknown): void => {
    if (!review.controller.signal.aborted) throw error;
  }).finally((): void => { review.running = false; });
  trackBackgroundTask(runtime.tasks, task, "Failed to review wed membership:");
}

onMidnightMaintenance((reply: MidnightMaintenanceReply): void => {
  requestWedMemberReview(reply.day);
});

/** 创建本代接纳门；对外连接和启动恢复完成前不执行 Telegram 查询。 */
export function initWedMemberReview(): void {
  stopWedMemberReview();
  wedMemberReview.current = {
    controller: new AbortController(),
    ready: false,
    pendingDay: null,
    lastDay: null,
    running: false,
    chatId: null,
    userId: null,
    observed: false,
  };
}

/**
 * Bot 握手和启动恢复成功后开启接纳，并消费启动期间的午夜通知。
 * 复核接入既有 wedRuntime 排空，遵守 docs/cn/04-invariants.md 的停机和持久化边界。
 */
export function enableWedMemberReview(): void {
  const review: WedMemberReview | null = wedMemberReview.current;
  if (review === null) return;
  review.ready = true;
  if (review.pendingDay === null) return;
  const day: string = review.pendingDay;
  review.pendingDay = null;
  requestWedMemberReview(day);
}

/** 停机关闭通知接纳并取消当前复核；在途任务留在 wedRuntime 中等待真正结算。 */
export function stopWedMemberReview(): void {
  const review: WedMemberReview | null = wedMemberReview.current;
  if (review === null) return;
  review.controller.abort();
  wedMemberReview.current = null;
}
