import { NO_VERIFICATION_EFFECTS } from "../../consts/antiRaid/verification";
import type {
  VerificationState,
  VerificationTransition,
} from "../../types/states/verification";
import { remindersOf } from "./shared";

/**
 * `/antiraid disable` 把整条链路关掉时，这个成员的验证记录的收尾转移。
 *
 * 一律回到 ABSENT，并删除机器人发出的验证提醒。这条转移只用于管理员主动关闭
 * `/antiraid` 或 `/init`；失去管理员权限/离群时走解释器的无网络紧急拆除路径。
 *
 * - 删除已发出的两类验证提醒（带有已失效的按钮）；入群公告和成员自己的消息不动。
 * - 不踢人：pending 到点的超时踢出、两个终态等落盘回执后的踢出，全部随记录一起作废。
 *   已发出的踢人请求不可撤回，它的结算事件回来时状态已不存在，不再触发后续动作
 *   （见 verificationRuntime.ts 的 dispatchVerification）。
 * - 不发 retractJoinCount：反刷群滑动窗口在同一条 Worker 消息里被
 *   `deactivateLockdownChat` 整个丢掉（见 workers/antiRaidWorker.ts 的 deactivateJoinGuard 分支）。
 *
 * 两个已落盘的终态返回 undefined 会让解释器发出 tombstone，重新启动后不会被
 * adopt 重放回来继续踢人（见 verificationRuntime.ts 的 publishVerificationChange）。
 */
export function handleGuardDisabled(
  state: VerificationState | undefined
): VerificationTransition {
  if (state?.kind === "pending") {
    return { next: undefined, effects: [remindersOf(state)] };
  }
  if (state?.kind === "checkingInviter" || state?.kind === "expelling") {
    return { next: undefined, effects: [remindersOf(state.snapshot)] };
  }
  return { next: undefined, effects: NO_VERIFICATION_EFFECTS };
}
