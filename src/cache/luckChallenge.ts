import type { LuckDraw } from "../types";

/** 抽签命令（src/commands/luckChallenge.ts）的内存状态。 */

/** 每日结果缓存：dayKey 记录当前缓存对应的东京时间日期，跟今天不一致就整体清空重开。
 * 只存"已确认"的抽签结果——即真的有一条 via_bot 消息把它发了出来，见
 * commands/luckChallenge.ts 的 confirmLuckDraw；这是落盘（postDiskIO）与
 * onDiskIORespawn 重放的唯一数据源，语义上等同于磁盘上 memory/luck/ 那份。 */
export const luckCacheState: { dayKey: string } = { dayKey: "" };
export const dailyLuckCache: Map<string, LuckDraw> = new Map();

/** 尚未确认的抽签结果：inline_query 应答（预览）阶段抽到、但还没等到对应的
 * via_bot 消息真的发出来，见 commands/luckChallenge.ts 的 getOrDrawLuck/
 * confirmLuckDraw 与 registerPendingRendering 的注释——不落盘、不算"今天
 * 测过"，用户光是打字预览（哪怕只是 @ 机器人几句、根本没打算测运势）不会
 * 留下任何痕迹。key 是 cacheKey（同 dailyLuckCache）。 */
export const pendingLuckDraws: Map<string, LuckDraw> = new Map();

/** pendingLuckDraws 的反查索引：渲染出的消息原文 → cacheKey。
 * via_bot 消息到达时能看到的只有最终文本，没有别的字段能带回是哪次查询产生的，
 * 只能靠"文本一模一样"认领，见 registerPendingRendering/confirmLuckDraw。
 * key 刻意不掺 userId：inline 查询永远以真人账号发起，但用户若以频道马甲/
 * 匿名管理员身份把结果发出来，via_bot 消息的 from 会被 Telegram 整个换成
 * 马甲（Channel_Bot / GroupAnonymousBot），真实 uid 在消息里根本不存在，
 * 掺了 uid 这类用户的抽签就永远认领不上（曾是线上实打实的静默丢单）。
 * 文本里嵌着 userLabel 与两位小数的随机概率值，本身已足够区分不同人的签。 */
export const pendingLuckRenderIndex: Map<string, string> = new Map();

/** 内联查询的全局滑动窗口频率限制：最近一分钟内各次请求的时刻戳。 */
export const recentCallTimestamps: number[] = [];
