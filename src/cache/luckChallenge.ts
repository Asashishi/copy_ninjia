import type { LuckTier } from "../types";

/** 抽签命令（src/commands/luckChallenge.ts）的内存状态。 */

/** 每日结果缓存：dayKey 记录当前缓存对应的东京时间日期，跟今天不一致就整体清空重开。 */
export const luckCacheState: { dayKey: string } = { dayKey: "" };
export const dailyLuckCache: Map<string, LuckTier> = new Map();

/** 内联查询的全局滑动窗口频率限制：最近一分钟内各次请求的时刻戳。 */
export const recentCallTimestamps: number[] = [];
