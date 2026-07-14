import type { LuckTier } from "../types";

/** /luck_challenge 内联抽签（src/commands/luckChallenge.ts）的调参常量。 */

/** 吉凶概率表：越靠两端（大吉/大凶）越稀有，中间几档更常见，仿传统抽签。 */
export const LUCK_TIERS: LuckTier[] = [
  { label: "大吉", weight: 7, comment: "简直要飞升啦，本天才要蹭蹭杂鱼的欧气～♡", fortunePercent: 90 },
  { label: "吉", weight: 15, comment: "运气不错嘛，本天才勉强夸你一句♡", fortunePercent: 75 },
  { label: "小吉", weight: 20, comment: "还算过得去啦，杂鱼继续加油♡", fortunePercent: 60 },
  { label: "尚可", weight: 26, comment: "平平淡淡才是真，别太贪心啦杂鱼♡", fortunePercent: 50 },
  { label: "小凶", weight: 17, comment: "有点不太妙哦，杂鱼小心点走路♡", fortunePercent: 40 },
  { label: "凶", weight: 10, comment: "呜哇，今天还是少折腾为好♡", fortunePercent: 25 },
  { label: "大凶", weight: 5, comment: "倒大霉预警！杂鱼你还是躺平一天吧♡", fortunePercent: 10 },
];

/**
 * 全局滑动窗口限流：每分钟最多 30 次内联查询应答，不分群、不分用户合并
 * 计数——内联查询会随用户每敲一个字符就触发一次。超额立即拒绝而非排队
 * （不同于 telegram.ts 的 apiThrottler，那是排队+重试），因为排队对一个
 * 几秒内就该有结果的内联查询没有意义。
 */
export const RATE_LIMIT_MAX_CALLS_PER_MINUTE: number = 30;
export const RATE_LIMIT_WINDOW_MS: number = 60_000;

/**
 * 「未卜先知」「概率论」两个内联结果各自固定的配图直链。TODO：占位 URL，
 * 图传到 Google Drive 后换成真实直链——注意 Drive 的普通分享链接
 * （.../file/d/<id>/view）是个网页，Telegram 抓不到图；要用
 * `https://drive.google.com/uc?export=view&id=<FILE_ID>` 这种直出图片字节
 * 的形式，且 Drive 对这种热链接有时大文件会插入确认页/偶尔限流的已知问题，
 * 如果发现缩略图时有时无，再考虑换成稳定的图床或自建静态资源。
 */
export const FORTUNE_THUMBNAIL_URL: string = "https://drive.google.com/uc?export=view&id=1o4wCIRE3XGSI7-MjXYWfvcPgR3QjClk-";
export const PROBABILITY_THUMBNAIL_URL: string = "https://drive.google.com/uc?export=view&id=1o4wCIRE3XGSI7-MjXYWfvcPgR3QjClk-";
