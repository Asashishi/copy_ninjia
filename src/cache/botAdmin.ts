/** 机器人自身管理员身份查询（src/infra/botAdmin.ts）的内存状态。 */

/** 进行中的 getChatMember 现查，按 chatId 去重：同群并发的未知身份查询共享同一次请求。 */
export const botAdminFetches: Map<number, Promise<boolean>> = new Map();
