import type { LuckDraw, LuckReceiptSecret } from "../types";

/** 抽签命令（src/commands/luckChallenge.ts）的内存状态。 */

/** 每日结果缓存：dayKey 记录当前缓存对应的东京时间日期，跟今天不一致就整体清空重开。
 * 只存"已确认"的抽签结果——即用户真的把它选中发了出来（chosen_inline_result
 * 或签名回执认领，见 commands/luckChallenge.ts）。确认时同步经 postDiskIO 落盘到
 * memory/luck/（只留当天一份文件），重启由 restoreLuckState 灌回，见
 * commands/luckChallenge.ts 模块头注释。 */
export const luckCacheState: { dayKey: string } = { dayKey: "" };
export const dailyLuckCache: Map<string, LuckDraw> = new Map();

/** 尚未确认的抽签结果：inline_query 应答（预览）阶段抽到、但还没等到用户
 * 真的选中发出，见 commands/luckChallenge.ts 的 getOrDrawLuck/
 * confirmLuckDraw 的注释——不算"今天测过"，
 * 用户光是打字预览（哪怕只是 @ 机器人几句、根本没打算测运势）不会留下
 * 任何痕迹。key 是 cacheKey（同 dailyLuckCache）。 */
export const pendingLuckDraws: Map<string, LuckDraw> = new Map();

/** 当前东京日期的持久化密钥；启动恢复后才允许生成预览。 */
export const luckReceiptSecretState: { current: LuckReceiptSecret | null } = { current: null };

/** 内联查询的全局滑动窗口频率限制：最近 RATE_LIMIT_WINDOW_MS（90 秒）内各次请求的时刻戳。 */
export const recentCallTimestamps: number[] = [];
