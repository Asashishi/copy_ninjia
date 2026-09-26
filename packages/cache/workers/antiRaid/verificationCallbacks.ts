/** owner: workers/antiRaid。验证回调的在途准入计数，不落盘。 */

/**
 * 管理员查询等待者数量；受理时登记，查询及其失效回执结算时减少。
 * 容量不超过 VERIFICATION_CALLBACK_CHECK_MAX。stop/adopt 使状态 token 失效，
 * 但不提前释放仍被 Promise 保留的名额；Worker 双工取消后自然排空，崩溃随 isolate 重建为零。
 */
export const verificationCallbackChecks: { current: number } = { current: 0 };

/**
 * 统一验证回执边界的在途数量，受理时增加、发送结算时减少，硬顶为 VERIFICATION_CALLBACK_REPLY_MAX。
 * stop/adopt 不提前释放名额；双工取消负责结算，Worker 崩溃后从零重建。
 */
export const verificationCallbackReplies: { current: number } = { current: 0 };

/** 回执满载时置位，每个 isolate 只告警一次；容量恒定，Worker 崩溃重建后复位。 */
export const verificationCallbackOverloadLogged: { current: boolean } = { current: false };
