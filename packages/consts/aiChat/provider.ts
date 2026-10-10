/**
 * 同一 AI 配额归属最多并发的真实模型请求数。SDK 内部重试始终占用原槽位。
 */
export const AI_PROVIDER_MAX_CONCURRENT: number = 16;

/**
 * 同一 AI 配额归属尚未开始的请求硬顶；请求闭包持有整轮提示词与媒体字节。
 */
export const AI_PROVIDER_MAX_PENDING: number = 128;

/**
 * AI 后台任务最多占用的等待位；剩余容量专门留给群友正在等待的交互请求。
 */
export const AI_PROVIDER_BACKGROUND_MAX_PENDING: number = 32;

/**
 * 连续优先执行交互任务的最大批次；到达后若有后台任务，至少放行一个后台任务。
 */
export const AI_PROVIDER_INTERACTIVE_BURST: number = 8;

/**
 * 已接纳、未结算的 Telegram 发送请求（message 类 activeCount，含发送调度器里等额度的）
 * 累计到该数量后，AI 回复进入软背压：不拒绝
 * 真人请求，只降低同群生成并发并暂停随机插话。
 */
export const AI_TELEGRAM_MESSAGE_ACTIVE_HIGH_WATER: number = 64;

/**
 * Telegram message 域一旦已有真实 429 等待项就立即触发 AI 软背压。
 */
export const AI_TELEGRAM_MESSAGE_RETRY_HIGH_WATER: number = 1;

/**
 * 供应商收尾详情诊断串（见 aiChat/ai/utils/finishDetails.ts）的截断长度：整段 JSON 按本值截断，
 * 不保证截断后仍是合法 JSON。详情对象来自响应体，兼容网关可以在其中放任意 JSON，
 * aiChat 各实现包与 ad_detect 传输层的不可用响应日志、回复轮次的 finishDetails 共用这一份上限。
 */
export const AI_FINISH_DETAILS_MAX_CHARS: number = 1_000;
