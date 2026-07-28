/**
 * DeepSeek 客户端（OpenAI 兼容接口）的传输层调参常量，见 packages/ai/deepseek.ts。
 * 「用哪个模型、采样温度多少、输出多长」属于各调用方自己的判断，留在各自领域的
 * consts 里（如 consts/antiRaid/adDetect.ts），不集中到这里。
 */

/** DeepSeek 的 OpenAI 兼容端点。 */
export const DEEPSEEK_API_BASE_URL: string = "https://api.deepseek.com";

/** 单次请求的整体超时（也是 SDK 内部每次重试各自的预算）。 */
export const DEEPSEEK_REQUEST_TIMEOUT_MS: number = 20_000;

/** 单次请求的 SDK 内部重试次数；调用方都是尽力而为的判定，不值得长时间重试。 */
export const DEEPSEEK_REQUEST_MAX_RETRIES: number = 1;

/**
 * 「HTTP 成功但没拿到可用正文」时的总尝试次数（含第一次）。
 *
 * 推理模型偶发这种结果：把 token 全花在推理上，正文一个字都没写，`finish_reason`
 * 照样是 `stop`（额度不够时则是 `length`）。SDK 的重试只覆盖网络错误和 5xx，
 * 对这种 200 响应不会重来。而它对调用方与「模型认为不是广告」完全不可区分——
 * 静默漏判且日志里没有任何痕迹，实测发生率不低，值得再试一次。
 * 上限是 2：这类空转多半随机，一次重试就能救回大部分；再多就变成了在模型
 * 抽风时自旋，与「判定失败不无限重试」那条约束冲突。
 */
export const DEEPSEEK_EMPTY_BODY_MAX_ATTEMPTS: number = 2;
