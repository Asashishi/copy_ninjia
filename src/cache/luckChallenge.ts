import type { LuckDraw } from "../types";

/** 抽签命令（src/commands/luckChallenge.ts）的内存状态。 */

/** 每日结果缓存：dayKey 记录当前缓存对应的东京时间日期，跟今天不一致就整体清空重开。
 * 只存"已确认"的抽签结果——即用户真的把它选中发了出来（chosen_inline_result
 * 或文本认领，见 commands/luckChallenge.ts）。确认时同步经 postDiskIO 落盘到
 * memory/luck/（只留当天一份文件），重启由 restoreLuckCache 灌回，见
 * commands/luckChallenge.ts 模块头注释。 */
export const luckCacheState: { dayKey: string } = { dayKey: "" };
export const dailyLuckCache: Map<string, LuckDraw> = new Map();

/** 尚未确认的抽签结果：inline_query 应答（预览）阶段抽到、但还没等到用户
 * 真的选中发出，见 commands/luckChallenge.ts 的 getOrDrawLuck/
 * confirmLuckDraw 与 registerPendingRendering 的注释——不算"今天测过"，
 * 用户光是打字预览（哪怕只是 @ 机器人几句、根本没打算测运势）不会留下
 * 任何痕迹。key 是 cacheKey（同 dailyLuckCache）。 */
export const pendingLuckDraws: Map<string, LuckDraw> = new Map();

/** pendingLuckDraws 的反查索引：渲染出的消息原文 → 所有候选 cacheKey。
 * 结果消息（via_bot 直发或转发副本）到达时能看到的只有最终文本，没有别的
 * 字段能带回是哪次查询产生的，只能靠"文本一模一样"认领，见
 * registerPendingRendering/confirmLuckDraw。
 * key 刻意不掺 userId：inline 查询永远以真人账号发起，但用户若以频道马甲/
 * 匿名管理员身份把结果发出来，via_bot 消息的 from 会被 Telegram 整个换成
 * 马甲（Channel_Bot / GroupAnonymousBot），真实 uid 在消息里根本不存在，
 * 掺了 uid 这类用户的抽签就永远认领不上（曾是线上实打实的静默丢单）。
 * 文本通常能区分签，但两个同名用户抽到同档结果（或同一所求文本）时可能
 * 完全相同，因此必须保留全部候选，不能让后一次预览覆盖前一次。兜底确认
 * 只在候选唯一时生效；歧义项等待 chosen_inline_result 主路消歧。 */
export const pendingLuckRenderIndex: Map<string, Set<string>> = new Map();

/** 内联查询的全局滑动窗口频率限制：最近一分钟内各次请求的时刻戳。 */
export const recentCallTimestamps: number[] = [];
