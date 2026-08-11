import type {
  VerificationEvent,
  VerificationState,
  VerificationTransition,
} from "../types/states/verification";
import { handleGuardDisabled } from "./verification/disable";
import { handleJoin, joinCreatesNewRecord } from "./verification/join";
import {
  handleCallback,
  handleConfirmedThreadComment,
  handleReminderLanded,
  handleTrackedMessage,
  handleVerifyTimeout,
} from "./verification/pending";
import { remindersOf } from "./verification/shared";
import {
  handleDedupeExpired,
  handleExpelSettled,
  handleKickRetry,
  handleKickSettled,
  handleTerminalAttemptBudgetExhausted,
  handleTerminalPersisted,
  handleTimeoutInviterVerdict,
} from "./verification/terminal";

export { joinCreatesNewRecord };

/**
 * 入群验证生命周期的显式状态机入口（纯逻辑，不做 I/O、不持有计时器）。
 * 各领域转移位于同名目录；本文件保留完整事件路由，便于穷尽审计状态图。
 *
 * 状态图（ABSENT = Map 里没有这个 key）：
 *
 *   ABSENT ──身份豁免/白名单拉人/管理员缓存命中/评论区活动──> EXEMPT
 *   ABSENT ──私密模式期间入群──────────────────────────> KICK_PENDING
 *   KICK_PENDING ──踢人请求结算────────────────────────────> KICKED
 *   KICK_PENDING ──请求发出前收到权威豁免──────────────────> EXEMPT
 *   ABSENT ──普通入群──────────────────────────────────────> PENDING
 *   PENDING ──评论区活动 / 异步管理员核查通过────────────────> EXEMPT
 *   PENDING ──验证按钮通过 / 中途离群────────────────────────> ABSENT
 *   PENDING ──超时/刷屏──> CHECKING_INVITER / EXPELLING（落盘后执行）
 *   CHECKING_INVITER ──管理员──> EXEMPT；非管理员──> EXPELLING
 *   EXPELLING ──处置完成──────────────────────────────────────> ABSENT
 *   EXPELLING（flood 且未开始执行）──权威评论区确认──────────> EXEMPT
 *   CHECKING_INVITER/EXPELLING ──新一次物理入群──> 按 ABSENT 重新判定
 *   KICK_PENDING/KICKED ──超出双路投递误差的重进──> KICK_PENDING（新 token）
 *   EXEMPT/KICKED ──去重窗口到期 / 离群────────────────────> ABSENT
 *   任意状态 ──主动关闭守卫（guardDisabled）────────────> ABSENT（清理机器人验证按钮）
 *
 * 同 kind 字段更新原地修改并原样返回；kind 变化才返回新对象。对象同一性既
 * 驱动计时器管理，也是异步结果的失效 token，领域 handler 不得随意复制状态。
 */
export function transitionVerification(
  state: VerificationState | undefined,
  event: VerificationEvent
): VerificationTransition {
  switch (event.type) {
    case "join":
      return handleJoin(state, event);
    case "left":
      // 带按钮提醒必须删；终态可能正因本机器人踢人收到 left，需等副作用结算。
      if (state?.kind === "pending") {
        return { next: undefined, effects: [remindersOf(state)] };
      }
      if (state?.kind === "checkingInviter" || state?.kind === "expelling") {
        return { next: state, effects: [] };
      }
      return { next: undefined, effects: [] };
    case "trackedMessage":
      return handleTrackedMessage(state, event);
    case "confirmedThreadComment":
      return handleConfirmedThreadComment(state, event);
    case "callback":
      return handleCallback(state, event);
    case "guardDisabled":
      return handleGuardDisabled(state);
    case "adminCheckResolved":
      if (state?.kind !== "pending") return { next: state, effects: [] };
      return {
        next: { kind: "exempt", label: state.label, isBot: state.isBot },
        effects: [
          remindersOf(state),
          { kind: "retractJoinCount", joinedAt: state.joinedAt },
        ],
      };
    case "verifyTimeout":
      return handleVerifyTimeout(state, event);
    case "terminalPersisted":
      return handleTerminalPersisted(state);
    case "terminalAttemptBudgetExhausted":
      return handleTerminalAttemptBudgetExhausted(state);
    case "timeoutInviterVerdict":
      return handleTimeoutInviterVerdict(state, event);
    case "expelSettled":
      return handleExpelSettled(state);
    case "kickRetry":
      return handleKickRetry(state);
    case "kickSettled":
      return handleKickSettled(state, event.now);
    case "reminderLanded":
      return handleReminderLanded(state, event);
    case "dedupeExpired":
      return handleDedupeExpired(state);
  }
}
