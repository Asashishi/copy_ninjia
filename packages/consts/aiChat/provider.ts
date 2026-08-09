/**
 * 同一 AI 配额归属最多并发的真实模型请求数。SDK 内部重试始终占用原槽位，避免
 * 端点故障时重试批次与新请求叠加成并发洪峰。
 */
export const AI_PROVIDER_MAX_CONCURRENT: number = 16;

/**
 * 同一 AI 配额归属尚未开始的请求硬顶。请求闭包可能持有整轮提示词与媒体字节，
 * 因此不能沿用 Telegram 轻量请求的超大等待容量。
 */
export const AI_PROVIDER_MAX_PENDING: number = 128;

/**
 * AI 后台任务最多占用的等待位；剩余容量专门留给群友正在等待的交互请求。
 */
export const AI_PROVIDER_BACKGROUND_MAX_PENDING: number = 32;

/**
 * 连续优先执行交互任务的最大批次；到达后若有后台任务，至少放行一个，防止记忆
 * 压缩与贴纸目录在持续聊天中永久饥饿。
 */
export const AI_PROVIDER_INTERACTIVE_BURST: number = 8;

/**
 * Telegram 发送请求在 grammY 下游累计到该数量后，AI 回复进入软背压。它不拒绝
 * 真人请求，只把同群生成并发降为一并暂停随机插话。
 */
export const AI_TELEGRAM_MESSAGE_ACTIVE_HIGH_WATER: number = 64;

/**
 * Telegram message 域一旦已有真实 429 等待项就立即触发 AI 软背压；429 比普通
 * throttler 等待更强，没必要再等队列增长。
 */
export const AI_TELEGRAM_MESSAGE_RETRY_HIGH_WATER: number = 1;
