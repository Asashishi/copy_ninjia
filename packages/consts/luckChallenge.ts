import type { LuckTier } from "../types/luckChallenge";

/** /luck_challenge 内联抽签（packages/commands/luckChallenge/）的调参常量。 */

/**
 * 吉凶概率表：越靠两端（大吉/大凶）越稀有，中间几档更常见，仿传统抽签。
 * fortunePercentRange 是行大运概率的浮动区间（闭区间，%），每次抽到新结果时
 * 都在区间内重新滚动一次，不再是查表就唯一确定的固定值（见
 * commands/luckChallenge/ 的 rollFortunePercent）。区间两两不重叠、按档递减，
 * 唯独「尚可」横跨 50（45~55）——半吉半凶的档位，行大运/倒大霉谁占上风本就该
 * 各半，浮动出来偶尔翻面是应有之义。
 */
export const LUCK_TIERS: readonly LuckTier[] = Object.freeze([
  Object.freeze({ label: "大吉", weight: 7, comment: "简直要飞升啦，杂鱼快让本天才蹭蹭欧气～♡", fortunePercentRange: Object.freeze([88, 97] as const) }),
  Object.freeze({ label: "吉", weight: 15, comment: "运气不错嘛，本天才勉强夸你一句♡", fortunePercentRange: Object.freeze([72, 82] as const) }),
  Object.freeze({ label: "小吉", weight: 20, comment: "还算过得去啦，杂鱼继续加油♡", fortunePercentRange: Object.freeze([58, 67] as const) }),
  Object.freeze({ label: "尚可", weight: 26, comment: "平平淡淡才是真，别太贪心啦杂鱼♡", fortunePercentRange: Object.freeze([45, 55] as const) }),
  Object.freeze({ label: "小凶", weight: 17, comment: "有点不太妙哦，杂鱼小心点走路♡", fortunePercentRange: Object.freeze([33, 42] as const) }),
  Object.freeze({ label: "凶", weight: 10, comment: "呜哇，今天还是少折腾为好♡", fortunePercentRange: Object.freeze([18, 28] as const) }),
  Object.freeze({ label: "大凶", weight: 5, comment: "倒大霉预警！杂鱼你还是躺平一天吧♡", fortunePercentRange: Object.freeze([3, 12] as const) }),
]);

// weight 必须凑满 100（drawLuckTier 按 1~100 掷骰累加匹配）：凑不满 100，
// 最后一档会因兜底 return 吃到多余权重；超过 100，末尾档位会被挤到摇不出——
// 加载期直接炸掉，不留一个只有注释约束、没人真正校验的隐性契约。
/** 启动期校验使用的吉凶档总权重，固定必须为 100。 */
const LUCK_TIER_WEIGHT_SUM: number = LUCK_TIERS.reduce((sum: number, tier: LuckTier): number => sum + tier.weight, 0);
if (LUCK_TIER_WEIGHT_SUM !== 100) {
  throw new Error(`LUCK_TIERS weights must sum to 100, got ${LUCK_TIER_WEIGHT_SUM}`);
}

/**
 * 全局滑动窗口限流：每 90 秒最多 300 次内联查询应答，不分群、不分用户合并
 * 计数——内联查询会随用户每敲一个字符就触发一次。超额立即拒绝而非排队
 * （不同于 infra/telegram/client.ts 的 apiThrottler，那是排队+重试），因为排队对一个
 * 几秒内就该有结果的内联查询没有意义。
 */
export const RATE_LIMIT_MAX_CALLS_PER_WINDOW: number = 300;
/** 全局内联查询滑动限频窗口时长。 */
export const RATE_LIMIT_WINDOW_MS: number = 90_000;

/**
 * 「未卜先知」「概率论」两个内联结果当前使用的配图直链。注意 Drive 的普通分享链接
 * （.../file/d/<id>/view）是个网页，Telegram 抓不到图；要用
 * `https://drive.google.com/uc?export=view&id=<FILE_ID>` 这种直出图片字节
 * 的形式，且 Drive 对这种热链接有时大文件会插入确认页/偶尔限流的已知问题，
 * 如果发现缩略图时有时无，再考虑换成稳定的图床或自建静态资源。
 */
export const FORTUNE_THUMBNAIL_URL: string = "https://drive.google.com/uc?export=view&id=1o4wCIRE3XGSI7-MjXYWfvcPgR3QjClk-";
/** 概率论结果使用的 Telegram 内联缩略图直链。 */
export const PROBABILITY_THUMBNAIL_URL: string = "https://drive.google.com/uc?export=view&id=1o4wCIRE3XGSI7-MjXYWfvcPgR3QjClk-";

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
 * 顺序淘汰最旧的（同 aiChat/ai/imageDescription.ts 的 descriptionCache 一个道理）。
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
