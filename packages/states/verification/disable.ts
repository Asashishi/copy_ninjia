import type {
  VerificationState,
  VerificationTransition,
} from "../../types/states/verification";

/**
 * `/antiraid disable` 把整条链路关掉时，这个成员的验证记录怎么收摊。
 *
 * 一律回到 ABSENT，**且不产生任何副作用**。这条转移表达的是「从此不再触发」，
 * 不是「把已经发生过的事撤销」：
 *
 * - 不删已经发出去的验证提醒与入群公告。那些是关掉之前真实发生过的交互，删掉
 *   等于替管理员抹现场；关掉开关的人要的是「别再管了」，不是「把痕迹清了」。
 *   留在群里的按钮点下去不会有人处理，主线程会当场应答一句说明
 *   （见 antiRaid/updateIngress.ts 的 handleVerificationCallback）。
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
  _state: VerificationState | undefined
): VerificationTransition {
  return { next: undefined, effects: [] };
}
