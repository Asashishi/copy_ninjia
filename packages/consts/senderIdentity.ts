/** 发送者身份缓存（packages/users/senderIdentity.ts）的调参常量。 */

/**
 * username -> 身份缓存的条目上限，超出按插入顺序淘汰最旧的（同
 * ai/imageDescription.ts 的临时描述缓存一个道理：热门用户反复发言不
 * 刷新位置，靠上限本身足够大兜底）。key 空间是"机器人有史以来在监听群里见过
 * 公开 username 的所有发送者"，长期运行下单调增长，需要一个真正生效的上限；
 * 取值远高于 README 建议的单实例群规模（约 15 群以内）在正常社群密度下的活跃发言
 * 用户数量级，正常运行基本不会触达，纯粹是防御性护栏。
 */
export const USER_CACHE_MAX: number = 15_000;
