import type {
  VerificationState,
  VerificationTransition,
} from "../../types/states/verification";
import { remindersOf } from "./shared";

/**
 * `/antiraid disable` 把整条链路关掉时，这个成员的验证记录怎么收摊。
 *
 * 一律回到 ABSENT，并删除机器人发出的验证按钮。这条转移只用于管理员主动关闭
 * `/antiraid` 或 `/init`；失去管理员权限/离群时走解释器的无网络紧急拆除路径。
 *
 * - 删除已经发出去的两类验证提醒；它们带着此刻已经失效的按钮，不能永久留在群里。
 *   入群公告和成员自己的消息不动，避免把关闭功能扩大成删除群成员内容。
 * - 不踢人。pending 到点的超时踢出、两个终态等落盘回执后的踢出，全部随记录一起
 *   作废——开关关掉之后还把人踢出去，是管理员最不可能预期的结果。已经发出去的
 *   踢人请求拦不住，但它的结算事件回来时状态已经不在，不会再有后续动作
 *   （见 verificationRuntime.ts 的 dispatchVerification）。
 * - 不发 retractJoinCount。反刷群滑动窗口在同一条 Worker 消息里被
 *   `deactivateLockdownChat` 整个丢掉（见 workers/antiRaidWorker.ts 的
 *   deactivateJoinGuard 分支），逐条撤销是对着一张已经不存在的表做无用功。
 *
 * 两个已落盘的终态返回 undefined 会让解释器发出 tombstone，因此重新启动后不会被
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
  return { next: undefined, effects: [] };
}
