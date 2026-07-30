/** 黑名单入群秒踢主线程侧代理（packages/antiRaid/blocklistGuard.ts）的内存状态。 */

/**
 * 最近已经替哪些 `(chatId, userId)` 的入群记过反刷群计数（键 → 记账时刻）。
 *
 * 同一次物理入群会经两条路径各投一次处置：`chat_member` 更新和
 * `new_chat_members` 服务消息（见 antiRaid/index.ts 的 handleChatMemberUpdate
 * 与 handleGroupJoinVerification）。两条都要拦——隐藏入群消息的群只有前者会
 * 到，而前者又要管理员权限才送达。但处置消息里的 joinedAt 只能带一次：普通
 * 入群由 states/verification.ts 的 joinCreatesNewRecord 去重，处置这一路没有
 * 那道闸，两条都带就等于 recordJoin 两次，反刷群阈值对黑名单账号实际减半，
 * 整群被提前打进私密模式，普通成员的发言权跟着被收走。
 *
 * 生命周期：claimBlockedJoiner 命中黑名单且本次要记账时写入；每次调用按
 * JOIN_WINDOW_MS 淘汰过期项（窗口之外的重复投递本来也不该合并成一次入群），
 * 并按 BLOCKLIST_JOIN_DEDUP_MAX_ENTRIES 兜住上界。写入一律先 delete 再 set，
 * 保证 Map 的插入顺序就是时间顺序，淘汰才能碰到第一个未过期项就停。
 * 主线程状态，与 Worker 崩溃重建无关；进程重启后清空——那时反刷群窗口
 * （Worker 侧的 joinWindows）本来也是空的，重新计数是正确的。
 */
export const recentBlockedJoinCounts: Map<string, number> = new Map();
