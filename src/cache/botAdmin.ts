/** 机器人自身管理员身份查询（src/infra/botAdmin.ts）的内存状态。 */

/** 进行中的 getChatMember 现查，按 chatId 去重：同群并发的未知身份查询共享同一次请求。 */
export const botAdminFetches: Map<number, Promise<boolean>> = new Map();

/** 每次 /init 切换都提升一代，使切换前已发出的查询结果不能回填新一代。 */
export const botAdminGenerations: Map<number, number> = new Map();

/**
 * 每群尚未 settle 的管理员身份查询数。发起查询时递增、finally 递减，
 * 归零后连同 generation 删除；进程重启后不恢复，容量受在途请求群数约束。
 */
export const botAdminGenerationUsers: Map<number, number> = new Map();
