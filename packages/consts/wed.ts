/** /wed 每群已发言成员集合的硬上限；满额保留已有 ID，退群腾位后才接纳新 ID。 */
export const WED_MEMBER_LIMIT: number = 150_000;
/** /wed 成员复核跨群共用的请求起始间隔；全局每秒最多检查 5 个 ID，不补发积压。 */
export const WED_MEMBER_REVIEW_INTERVAL_MS: number = 200;
/** /wed 每群并存的发起人会话上限，每位用户只保留一张结果。 */
export const WED_SESSION_LIMIT: number = 512;
/** /wed 主线程交互的全局并发上限，出站等待仍占用原执行槽。 */
export const WED_MAX_CONCURRENT: number = 32;
/** /wed 尚未开始的交互全局上限；队列只保留交互上下文，不预取头像。 */
export const WED_MAX_PENDING: number = 512;
/** /wed 每轮最多核实的候选用户数；只有确认没有可用头像才计入，限制请求量。 */
export const WED_DRAW_ATTEMPTS: number = 8;
/** /wed 每轮允许的查询未完成次数；不计入 WED_DRAW_ATTEMPTS，累计到上限即放弃本轮。 */
export const WED_DRAW_TRANSIENT_LIMIT: number = 3;
/** /wed 按钮回调所属领域前缀。 */
export const WED_CALLBACK_PREFIX: string = "wed:";
/** /wed 候选查询、头像下载与图片发送/编辑的请求预算；删除和提示复用统一出站生命周期。 */
export const WED_OPERATION_TIMEOUT_MS: number = 30_000;
/** /wed 昵称展示长度上限，保证双昵称图注不超过 Telegram 限额。 */
export const WED_NAME_MAX_CHARS: number = 128;
