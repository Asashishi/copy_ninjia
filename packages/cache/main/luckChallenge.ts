/** owner: main。抽签命令（packages/commands/luckChallenge/）的内存状态。 */

import { RATE_LIMIT_MAX_CALLS_PER_WINDOW } from "../../consts/luckChallenge";
import { TimestampDeque } from "../../libs/timestampDeque";
import type { LuckReceiptSecret } from "../../types/diskIO/storage";
import type { LuckDraw } from "../../types/luckChallenge";

/** dayKey 记录当前日缓存对应的配置时区自然日；与今天不一致时整体清空并切换到新日（commands/luckChallenge/cache.ts 的 adoptLuckSecret）；进程重启后为空串，由 restoreLuckState 填充。 */
export const luckCacheState: { dayKey: string } = { dayKey: "" };
/** 当日已确认抽签结果，即用户选中并发出的 inline 结果（chosen_inline_result 见
 *  commands/luckChallenge/telegramAdapter.ts，签名回执认领见 commands/luckChallenge/receipt.ts）。
 *  确认时经 postDiskIO 落盘到 memory/luck/（只留当天一份文件），启动时由 restoreLuckState 灌回
 *  （见 commands/luckChallenge/cache.ts）；跨日整体清空。
 *  容量上限 DAILY_LUCK_CACHE_MAX（见 consts/luckChallenge.ts），撑满时拒绝新 key，不淘汰已确认项。 */
export const dailyLuckCache: Map<string, LuckDraw> = new Map();
/** 当日容量撑满后是否已记过日志；跨日随缓存一起复位。 */
export const dailyLuckCacheSaturated: { current: boolean } = { current: false };

/** 尚未确认的抽签结果：inline_query 应答（预览）阶段抽到、尚未被用户选中发出的草稿
 * （见 commands/luckChallenge/cache.ts 的 getOrDrawLuck 与 receipt.ts 的 confirmLuckDraw），
 * 不计入「今天测过」。key 是 cacheKey（同 dailyLuckCache）。
 * 清理：confirmLuckDraw 认领后移入 dailyLuckCache 并删除本项，跨日随整份缓存清空。
 * 容量：硬顶 PENDING_LUCK_CACHE_MAX（见 consts/luckChallenge.ts），经
 * libs/boundedMap.ts 的 setBoundedMapValue 写入，撑满时淘汰最早插入的一项（FIFO）。
 * 进程重启后为空。 */
export const pendingLuckDraws: Map<string, LuckDraw> = new Map();

/** 当前配置时区日期的持久化密钥；启动恢复前为 null，此时不生成预览。 */
export const luckReceiptSecretState: { current: LuckReceiptSecret | null } = { current: null };

/** 日期轮换、Worker 重建监听与跨日 fail-closed 判定的主线程运行态。 */
export const luckRuntimeState: {
  dayRefreshPromise: Promise<void> | null;
  respawnRecoveryInitialized: boolean;
  daySwitchedInProcess: boolean;
} = {
  dayRefreshPromise: null,
  respawnRecoveryInitialized: false,
  daySwitchedInProcess: false,
};

/** 内联查询的全局滑动窗口频率限制：最近 RATE_LIMIT_WINDOW_MS 内各次请求的时刻戳。
 *  只在仍有配额时记账，长度不超过 RATE_LIMIT_MAX_CALLS_PER_WINDOW，
 *  环形缓冲按该值定容，见 libs/slidingWindowRateLimit.ts。
 *  清理：每次记账前由 TimestampDeque.trim 丢掉窗口外的队首与时钟回拨后落在未来
 *  的队尾；没有整体清空路径，进程重启归零。 */
export const recentCallTimestamps: TimestampDeque =
  new TimestampDeque(RATE_LIMIT_MAX_CALLS_PER_WINDOW);
