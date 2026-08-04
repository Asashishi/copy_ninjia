/** 群类型观测（packages/antiRaid/chatKind.ts）的主线程内存状态。 */

/**
 * 各群是不是超级群，纯内存、不落盘。
 *
 * 只有主线程看得见 `chat.type`——每条 update 都带着它，而入群守卫线程手上只有
 * 一个 `chatId: number`（事件按设计只带最小字段）。这张表是那一侧镜像的权威副本，
 * 同时兼作**投递去重**：群类型近乎恒定（只有普通群升级成超级群这一次单向跃迁），
 * 不去重的话每条群消息都会向 Worker 多投一条同值消息。
 *
 * 条目数与见过的群数同阶；`deactivateChat` / 群 teardown 时删除，进程重启后
 * 为空，由随后的第一条 update 重新填上。
 */
export const chatIsSupergroupById: Map<number, boolean> = new Map();
