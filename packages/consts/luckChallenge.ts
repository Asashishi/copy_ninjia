import type { LuckTier } from "../types/luckChallenge";

/** /luck_challenge 内联抽签（packages/commands/luckChallenge/）的调参常量。 */

/**
 * commands/luckChallenge/ 的吉凶权重与行大运概率区间（闭区间，%）。
 * 当日密钥与 cache key 确定档位及区间内的概率，后者保留两位小数。
 * 区间两两不重叠、按档递减，「尚可」的 45~55 区间跨越 50。
 */
export const LUCK_TIERS: readonly LuckTier[] = [
  { label: "大吉", weight: 7, fortunePercentRange: [88, 97] as const },
  { label: "吉", weight: 15, fortunePercentRange: [72, 82] as const },
  { label: "小吉", weight: 20, fortunePercentRange: [58, 67] as const },
  { label: "尚可", weight: 26, fortunePercentRange: [45, 55] as const },
  { label: "小凶", weight: 17, fortunePercentRange: [33, 42] as const },
  { label: "凶", weight: 10, fortunePercentRange: [18, 28] as const },
  { label: "大凶", weight: 5, fortunePercentRange: [3, 12] as const },
];

/**
 * 按持久化 label 取回当前运势档位。固定七档使用分支查找，避免启动恢复与
 * 主线程水合时为每条记录遍历整张表；未知 label 仍返回 undefined 并由调用方
 * fail closed。所属模块：commands/luckChallenge/cache.ts、workers/diskIO/snapshotFiles.ts。
 */
export function luckTierByLabel(label: string): LuckTier | undefined {
  switch (label) {
    case "大吉": return LUCK_TIERS[0];
    case "吉": return LUCK_TIERS[1];
    case "小吉": return LUCK_TIERS[2];
    case "尚可": return LUCK_TIERS[3];
    case "小凶": return LUCK_TIERS[4];
    case "凶": return LUCK_TIERS[5];
    case "大凶": return LUCK_TIERS[6];
    default: return undefined;
  }
}
if (LUCK_TIERS.some(
  (tier: LuckTier): boolean => luckTierByLabel(tier.label) !== tier
)) {
  throw new Error("luckTierByLabel must cover every current LUCK_TIERS label exactly once");
}

/** commands/luckChallenge/ 的启动期权重校验；总和必须覆盖 drawLuckTier 的 [0, 100) 输入区间。 */
const LUCK_TIER_WEIGHT_SUM: number = LUCK_TIERS.reduce((sum: number, tier: LuckTier): number => sum + tier.weight, 0);
if (LUCK_TIER_WEIGHT_SUM !== 100) {
  throw new Error(`LUCK_TIERS weights must sum to 100, got ${LUCK_TIER_WEIGHT_SUM}`);
}

/**
 * 全局滑动窗口限流：每 90 秒最多 300 次内联查询应答，不分群、不分用户合并
 * 计数——内联查询会随用户每敲一个字符就触发一次。超额立即拒绝而非排队
 * （不同于 Telegram 总闸的排队与 429 退避），因为排队对一个
 * 几秒内就该有结果的内联查询没有意义。
 */
export const RATE_LIMIT_MAX_CALLS_PER_WINDOW: number = 300;
/** 全局内联查询滑动限频窗口时长。 */
export const RATE_LIMIT_WINDOW_MS: number = 90_000;

/** "同款问题"按钮上展示的所求事项摘要，超过这个字符数就截断并加 "..."。 */
export const SAME_QUESTION_LABEL_MAX_LEN: number = 4;

/** 只有这些内联结果代表用户实际选中了运势结果。 */
export const LUCK_RESULT_IDS: ReadonlySet<string> = new Set([
  "luck-fortune",
  "luck-fortune-text",
  "luck-probability",
]);

/**
 * pendingLuckDraws（见 cache/main/luckChallenge.ts）的 key 数量上限，超出按插入
 * 顺序淘汰最旧的（同 cache/workers/aiChat/imageDescription.ts 的 transientDescriptionCache 一个道理）。
 * 这个 Map 记的是"预览阶段抽到、但还没被用户选中确认"的结果——inline_query
 * 是打字即触发的预览，用户每敲一个字符都可能新增一条从未被选中过的 key，
 * 只有到东京零点跨天才会整体清空（见 commands/luckChallenge/cache.ts 的
 * ensureLuckCacheFreshForToday），单日内没有其它清理时机；需要一个真正
 * 生效的上限防止忙碌的一天里被打字预览堆到很大。签名回执（libs/luckReceipt.ts）
 * 是自描述验签，不占用任何反向索引，不受此上限约束。 */
export const PENDING_LUCK_CACHE_MAX: number = 15_000;

/**
 * dailyLuckCache（见 cache/main/luckChallenge.ts）当日已确认结果的数量上限。
 *
 * key 是 `userId:sha256(问题原文)`，**问题原文由用户随手输入**，所以「当日唯一 key
 * 数」不是自然上界而是攻击者选的数字：反复用新问题串点选内联结果，就能让主线程
 * 这张 Map、Disk I/O Worker 侧的当日镜像与 `memory/luck/<day>.json` 三处一起整天
 * 长下去，而下次启动 `restoreLuckState` 还要把整个文件逐条按 LUCK_TIERS 校验一遍
 * 才能开始收 update。
 *
 * 撑满时**拒绝新的 key、不淘汰已有的**（同 AD_DETECT_MAX_PENDING_SENDERS 的取舍）：
 * 淘汰最旧等于让一个刷子把当天正常用户的记录顶掉，而拒绝新的只是让越界的那些
 * 「今天测过」记不住——抽签派生是确定性的（同一密钥同一 key 必得同一结果），
 * 重新预览拿到的仍是同一条，用户可见行为不变。这道闸同时兜住了落盘：越界的
 * key 根本不会产生 luckDraw 消息。
 */
export const DAILY_LUCK_CACHE_MAX: number = 45_000;
